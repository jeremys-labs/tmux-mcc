import { EventEmitter } from 'events';
import type { Response } from 'express';
import type { SSEEventType } from '../types/chat.js';

const HEARTBEAT_INTERVAL_MS = 30_000;

interface Subscriber {
  res: Response;
  agentKey: string;
  heartbeat: ReturnType<typeof setInterval>;
}

export class ChatStreamService extends EventEmitter {
  private subscribers = new Map<string, Set<Subscriber>>();

  subscribe(agentKey: string, res: Response): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    // Periodic heartbeat to keep connection alive through proxies/browsers
    const heartbeat = setInterval(() => {
      try { res.write(':heartbeat\n\n'); } catch { /* connection dead, close handler cleans up */ }
    }, HEARTBEAT_INTERVAL_MS);

    const subscriber: Subscriber = { res, agentKey, heartbeat };

    if (!this.subscribers.has(agentKey)) {
      this.subscribers.set(agentKey, new Set());
    }
    this.subscribers.get(agentKey)!.add(subscriber);

    // Send connected event
    this.sendSSE(res, 'connected', { agent: agentKey });

    // Clean up on close
    res.on('close', () => {
      clearInterval(subscriber.heartbeat);
      const subs = this.subscribers.get(agentKey);
      if (subs) {
        subs.delete(subscriber);
        if (subs.size === 0) {
          this.subscribers.delete(agentKey);
        }
      }
    });
  }

  broadcastDelta(agent: string, messageId: string, content: string, seq?: number): void {
    const data: Record<string, unknown> = { messageId, content };
    if (seq !== undefined) data.seq = seq;
    this.broadcast(agent, 'message.delta', data);
  }

  broadcastFinal(agent: string, messageId: string, fullContent: string, seq?: number): void {
    const data: Record<string, unknown> = { messageId, content: fullContent, complete: true };
    if (seq !== undefined) data.seq = seq;
    this.broadcast(agent, 'message.final', data);
  }

  broadcastError(agent: string, messageId: string, error: string, seq?: number): void {
    const data: Record<string, unknown> = { messageId, error };
    if (seq !== undefined) data.seq = seq;
    this.broadcast(agent, 'message.error', data);
  }

  broadcastAbort(agent: string, messageId: string, reason: string): void {
    this.broadcast(agent, 'message.aborted', { messageId, reason });
  }

  broadcastSideResult(agent: string, content: string, question?: string): void {
    const data: Record<string, unknown> = { content };
    if (question) data.question = question;
    this.broadcast(agent, 'message.side_result', data);
  }

  broadcastContextUpdate(agent: string, tokens: number, maxTokens: number): void {
    const percentUsed = maxTokens > 0 ? Math.round((tokens / maxTokens) * 100) : 0;
    this.broadcast(agent, 'context.update', { tokens, maxTokens, percentUsed });
  }

  /** Broadcast an error to all agents with active subscribers (e.g. on gateway disconnect). */
  broadcastErrorToAll(error: string): void {
    for (const agentKey of this.subscribers.keys()) {
      this.broadcast(agentKey, 'message.error', { messageId: '', error });
    }
  }

  getSubscriberCount(agent: string): number {
    return this.subscribers.get(agent)?.size ?? 0;
  }

  private broadcast(agent: string, eventType: SSEEventType, data: Record<string, unknown>): void {
    const subs = this.subscribers.get(agent);
    if (!subs) return;

    for (const sub of subs) {
      this.sendSSE(sub.res, eventType, data);
    }

    this.emit(eventType, { agent, ...data });
  }

  private sendSSE(res: Response, event: string, data: Record<string, unknown>): void {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }
}
