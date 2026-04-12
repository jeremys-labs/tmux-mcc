import { Router } from 'express';
import type { Request, Response } from 'express';
import type { AppConfig } from '../types/config.js';
import type { ChatDB } from '../db.js';
import type { GatewayClient } from '../gateway/client.js';
import type { ChatStreamService } from '../services/chat-streaming.js';
import type { HarnessBridgeService } from '../services/harness-bridge.js';
import crypto from 'crypto';

interface ChatDeps {
  config: AppConfig;
  db: ChatDB;
  gateway: GatewayClient;
  streaming: ChatStreamService;
  harness?: HarnessBridgeService;
}

// Strip ANSI escape codes from PTY output before saving to DB.
// Cursor-movement codes (A-D) are replaced with a space because the PTY uses
// them as visual whitespace (e.g. \x1b[1C between words). All other sequences
// are decorative and removed entirely.
export function stripAnsi(str: string): string {
  return str
    .replace(/\x1b\[[\x30-\x3f]*([A-Za-z@`])/g, (_, cmd) =>
      cmd === 'A' || cmd === 'B' || cmd === 'C' || cmd === 'D' ? ' ' : '',
    )
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b[P^_X][^\x1b]*(?:\x1b\\)/g, '')
    .replace(/\x1b[@-Z\\-_]/g, '');
}

// Per-session harness SSE subscriptions: sessionId -> unsubscribe fn
const harnessSubscriptions = new Map<string, () => void>();

const SYSTEM_MESSAGE_PATTERNS = /^(ANNOUNCE_SKIP|NO_REPLY|NO_?|SKIP|ACK|HEARTBEAT|PING|PONG)$/i;

interface ChatAttachmentInput {
  type?: string;
  mimeType?: string;
  fileName?: string;
  content: string; // base64
}

function getAgentKey(req: Request): string {
  const key = req.params.agentKey;
  return Array.isArray(key) ? key[0] : key;
}

function validateAgent(config: AppConfig, agentKey: string, res: Response): boolean {
  if (!config.agents[agentKey]) {
    res.status(404).json({ error: `Agent '${agentKey}' not found` });
    return false;
  }
  return true;
}

export function createChatRouter({ config, db, gateway, streaming, harness }: ChatDeps): Router {
  const router = Router();

  // SSE subscription
  router.get('/chat-stream/:agentKey', (req: Request, res: Response) => {
    const agentKey = getAgentKey(req);
    if (!validateAgent(config, agentKey, res)) return;
    streaming.subscribe(agentKey, res);
  });

  // Send message
  router.post('/chat/:agentKey', async (req: Request, res: Response) => {
    const agentKey = getAgentKey(req);
    if (!validateAgent(config, agentKey, res)) return;

    const { content, idempotencyKey, metadata, attachments } = req.body as {
      content?: string;
      idempotencyKey?: string;
      metadata?: Record<string, unknown>;
      attachments?: ChatAttachmentInput[];
    };

    const hasText = typeof content === 'string' && content.trim().length > 0;
    const hasAttachments = Array.isArray(attachments) && attachments.length > 0;

    if (!hasText && !hasAttachments) {
      res.status(400).json({ error: 'content or attachments required' });
      return;
    }

    const timestamp = Date.now();
    const key = idempotencyKey || crypto.randomUUID();
    const result = db.addMessage(agentKey, 'user', content ?? '', timestamp, key, metadata);

    if (result.duplicate) {
      res.json({ seq: result.seq, duplicate: true });
      return;
    }

    // Harness-backed agent intercept — runs before Gateway check because
    // the sidecar is independent of the OpenClaw Gateway.
    const agentCfg = config.agents[agentKey];
    if (harness && agentCfg?.providerType === 'persistent-harness' && agentCfg.harnessConfig) {
      try {
        const session = await harness.sendMessage(agentKey, agentCfg.harnessConfig, content ?? '');
        res.json({ seq: result.seq, duplicate: false, idempotencyKey: key });

        // Subscribe to events once per session
        const { sessionId } = session;
        if (!harnessSubscriptions.has(sessionId)) {
          let accumulated = '';
          const unsubscribe = harness.subscribe(sessionId, (event) => {
            const type = event.type as string;
            if (type === 'output_chunk') {
              accumulated += (event.payload as Record<string, unknown>)?.text ?? '';
            } else if (type === 'task_completed') {
              const cleanText = (event.payload as Record<string, unknown>)?.text as string ?? stripAnsi(accumulated.trim());
              accumulated = '';
              if (cleanText) {
                const now = Date.now();
                const iKey = `harness-${agentKey}-${now}-${Math.random().toString(36).slice(2)}`;
                const r = db.addMessage(agentKey, 'assistant', cleanText, now, iKey);
                if (!r.duplicate) {
                  streaming.broadcastFinal(agentKey, '', cleanText, r.seq);
                }
              }
            } else if (type === 'waiting_for_input') {
              const partialText = (event.payload as Record<string, unknown>)?.text as string ?? stripAnsi(accumulated.trim());
              accumulated = '';
              const noticeText = partialText
                ? `${partialText}\n\n_Waiting for your confirmation — reply to continue._`
                : `_Waiting for your confirmation — reply to continue._`;
              const now = Date.now();
              const iKey = `harness-waiting-${agentKey}-${now}-${Math.random().toString(36).slice(2)}`;
              const r = db.addMessage(agentKey, 'assistant', noticeText, now, iKey);
              if (!r.duplicate) {
                streaming.broadcastFinal(agentKey, '', noticeText, r.seq);
              }
            } else if (type === 'session_exited' || type === 'session_errored') {
              harnessSubscriptions.delete(sessionId);
              unsubscribe();
              accumulated = '';
              if (type === 'session_errored') {
                console.error(`[Harness] session errored for ${agentKey}`);
              }
            }
          });
          harnessSubscriptions.set(sessionId, unsubscribe);
        }
      } catch (e) {
        console.error('[Harness-Send] Error:', (e as Error).message);
        res.status(500).json({ error: (e as Error).message });
      }
      return;
    }

    // Forward to gateway
    const sessionKey = `agent:${agentKey}:webchat:user`;

    try {
      if (gateway.isConnected) {
        await gateway.request('chat.send', {
          sessionKey,
          message: content ?? '',
          idempotencyKey: key,
          ...(hasAttachments ? { attachments } : {}),
        });
      }
    } catch (err) {
      // Log but don't fail the request -- message is persisted
      console.error(`Gateway forward failed for ${agentKey}:`, err);
    }

    res.json({ seq: result.seq, duplicate: false, idempotencyKey: key });
  });

  // Get chat history
  // Query params:
  //   ?since=<seq>   — return only messages after this seq (for polling new messages)
  //   ?before=<seq>  — return up to `limit` messages before this seq (for "load older")
  //   ?limit=<n>     — cap results (default 100 for initial load, ignored when ?since is set)
  router.get('/chat-history/:agentKey', (req: Request, res: Response) => {
    const agentKey = getAgentKey(req);
    if (!validateAgent(config, agentKey, res)) return;

    const sinceParam = req.query.since;
    const beforeParam = req.query.before;
    const limitParam = req.query.limit;
    const since = sinceParam ? Number(sinceParam) : undefined;
    const before = beforeParam ? Number(beforeParam) : undefined;
    const limit = limitParam ? Number(limitParam) : 100;

    const filterSystem = (msgs: Record<string, unknown>[]) =>
      msgs.filter((m) => !SYSTEM_MESSAGE_PATTERNS.test(String(m.content).trim()));

    if (since !== undefined && since > 0) {
      // New messages only — no limit needed
      res.json(filterSystem(db.getMessagesSince(agentKey, since)));
    } else if (before !== undefined && before > 0) {
      // Pagination: load older messages before a given seq
      res.json(filterSystem(db.getMessagesBefore(agentKey, before, limit)));
    } else {
      // Initial load: return last N messages
      res.json(filterSystem(db.getMessages(agentKey, limit)));
    }
  });

  // Clear chat history
  router.delete('/chat/:agentKey', (req: Request, res: Response) => {
    const agentKey = getAgentKey(req);
    if (!validateAgent(config, agentKey, res)) return;

    db.clearMessages(agentKey);
    res.json({ cleared: true });
  });

  // BTW — ephemeral side question (not saved to history)
  router.post('/chat/:agentKey/btw', async (req: Request, res: Response) => {
    const agentKey = getAgentKey(req);
    if (!validateAgent(config, agentKey, res)) return;

    const { question } = req.body as { question?: string };
    if (!question || !question.trim()) {
      res.status(400).json({ error: 'question required' });
      return;
    }

    const sessionKey = `agent:${agentKey}:webchat:user`;

    try {
      if (gateway.isConnected) {
        // BTW is a slash command sent via chat.send — the Gateway parses /btw <question>
        // and routes it as an ephemeral side question, responding via chat.side_result event.
        await gateway.request('chat.send', {
          sessionKey,
          message: `/btw ${question.trim()}`,
          idempotencyKey: `btw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        });
        res.json({ ok: true });
      } else {
        res.status(503).json({ error: 'Gateway not connected' });
      }
    } catch (err) {
      console.error(`Gateway btw failed for ${agentKey}:`, (err as Error).message);
      res.status(502).json({ error: 'Gateway request failed', detail: (err as Error).message });
    }
  });

  // Interrupt/abort response
  router.post('/chat/:agentKey/interrupt', async (req: Request, res: Response) => {
    const agentKey = getAgentKey(req);
    if (!validateAgent(config, agentKey, res)) return;

    const sessionKey = `agent:${agentKey}:webchat:user`;

    // Always broadcast abort to the UI so the streaming state clears,
    // even if the gateway call fails (method unsupported, timeout, etc.)
    let gatewayOk = false;
    try {
      if (gateway.isConnected) {
        await gateway.request('chat.abort', { sessionKey });
        gatewayOk = true;
      }
    } catch (err) {
      console.error(`Gateway interrupt failed for ${agentKey}:`, (err as Error).message);
    }

    // Always clear streaming state on the client
    streaming.broadcastAbort(agentKey, '', 'User interrupted');
    res.json({ interrupted: true, gatewayAck: gatewayOk });
  });

  return router;
}
