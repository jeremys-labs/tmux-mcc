import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { loadConfig, resolveContentRoot } from './config.js';
import { ensureContentDirs } from './content.js';
import { loadAgentModels } from './models.js';
import { createChatDB } from './db.js';
import { GatewayClient } from './gateway/client.js';
import { ChatStreamService } from './services/chat-streaming.js';
import { createChatRouter } from './routes/chat.js';
import { HarnessBridgeService } from './services/harness-bridge.js';
import { createConfigRouter } from './routes/config.js';
import { createHealthRouter } from './routes/health.js';
import { createFileRoutes } from './routes/files.js';
import { createStandupRoutes } from './routes/standup.js';
import { createChannelRoutes } from './routes/channels.js';
import { createAgentDataRoutes } from './routes/agent-data.js';
import { createVoiceRouter, startVoiceHealthChecks, stopVoiceHealthChecks } from './routes/voice.js';
import { createProjectsRouter } from './routes/projects.js';
import { createSearchRouter } from './routes/search.js';

const PORT = parseInt(process.env.SERVER_PORT || '8081', 10);

// Load config and ensure directories
const contentRoot = resolveContentRoot();
const config = loadConfig(contentRoot);
ensureContentDirs(contentRoot);

// Resolve agent models from openclaw.json
const agentModels = loadAgentModels(contentRoot, Object.keys(config.agents));

// Inject model into each agent config
for (const [key, model] of Object.entries(agentModels)) {
  if (config.agents[key] && model) {
    config.agents[key].model = model;
  }
}

// Database
const dbPath = path.join(contentRoot, 'databases', 'chat.db');
const db = createChatDB(dbPath);

// Gateway client
const gateway = new GatewayClient(config.gateway.url, config.gateway.token);

// Chat streaming service
const streaming = new ChatStreamService();

// Harness bridge (only active when sidecarPort is configured)
const harness = config.sidecarPort ? new HarnessBridgeService(config.sidecarPort) : undefined;

// Build reverse lookup: sessionKey -> agentKey
const sessionToAgent: Record<string, string> = {};
for (const key of Object.keys(config.agents)) {
  sessionToAgent[`agent:${key}:webchat:user`] = key;
}

// Gateway protocol tokens that should not appear in chat
const SYSTEM_MESSAGE_PATTERNS = /^(ANNOUNCE_SKIP|NO_REPLY|NO_?|SKIP|ACK|HEARTBEAT|PING|PONG)$/i;

// Extract text content from Gateway message object
function extractMessageText(message: Record<string, unknown>): string | null {
  const content = message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((block: Record<string, unknown>) => block.type === 'text')
      .map((block: Record<string, unknown>) => block.text as string)
      .join('');
  }
  if (typeof message.text === 'string') return message.text;
  return null;
}

function isSystemMessage(text: string): boolean {
  return SYSTEM_MESSAGE_PATTERNS.test(text.trim());
}

// Handle gateway events
// Gateway sends: { type: 'event', event: 'chat', payload: { state, sessionKey, message } }
gateway.on('event', (frame: Record<string, unknown>) => {
  const event = frame.event as string;

  if (event === 'chat.side_result') {
    const payload = frame.payload as Record<string, unknown>;
    if (!payload) return;

    const sessionKey = payload.sessionKey as string;
    const agent = sessionToAgent[sessionKey];
    if (!agent) return;

    // Gateway side_result payload shape: { kind, sessionKey, text, question, runId, ts, isError }
    // text is directly on payload; fall back to payload.message for legacy compat
    const directText = typeof payload.text === 'string' ? payload.text : null;
    if (directText && directText.trim()) {
      const question = typeof payload.question === 'string' ? payload.question : undefined;
      streaming.broadcastSideResult(agent, directText.trim(), question);
    } else {
      const message = payload.message as Record<string, unknown> | undefined;
      if (message) {
        const text = extractMessageText(message);
        if (text) {
          streaming.broadcastSideResult(agent, text);
        }
      }
    }
  }

  if (event === 'chat') {
    const payload = frame.payload as Record<string, unknown>;
    if (!payload) return;

    const sessionKey = payload.sessionKey as string;
    const agent = sessionToAgent[sessionKey];
    if (!agent) return;

    const state = payload.state as string;
    const message = payload.message as Record<string, unknown> | undefined;

    if (state === 'delta' && message) {
      const text = extractMessageText(message);
      if (text && !isSystemMessage(text)) {
        streaming.broadcastDelta(agent, '', text);
      }
    } else if (state === 'final' && message) {
      const text = extractMessageText(message);
      if (text && !isSystemMessage(text)) {
        const timestamp = Date.now();
        const result = db.addMessage(agent, 'assistant', text, timestamp);
        streaming.broadcastFinal(agent, '', text, result.seq);
      }
    } else if (state === 'error') {
      const error = (payload.error || 'Unknown error') as string;
      streaming.broadcastError(agent, '', error);
    }
  }
});

gateway.on('state', (state: string) => {
  console.log(`[Gateway] State: ${state}`);
  if (state === 'disconnected') {
    streaming.broadcastErrorToAll('Gateway disconnected — response interrupted');
  }
});

gateway.on('error', (err: Error) => {
  console.error('[Gateway] Error:', err.message);
});

// Express app
const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Mount routes
app.use('/api', createHealthRouter(gateway));
app.use('/api', createConfigRouter(config));
app.use('/api', createChatRouter({ config, db, gateway, streaming, harness }));
app.use('/api', createFileRoutes(contentRoot));
app.use('/api', createStandupRoutes(contentRoot));
app.use('/api', createChannelRoutes(contentRoot));
app.use('/api', createAgentDataRoutes(config, contentRoot, gateway));
app.use('/api', createVoiceRouter(config));
app.use('/api', createProjectsRouter(contentRoot));
app.use('/api/search', createSearchRouter(db));

// Serve built client (production)
const clientDist = path.join(import.meta.dirname, '../../client/dist');

// Force no-cache on service worker files so updates propagate immediately
app.get(['/sw.js', '/registerSW.js'], (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  next();
});

// Nuke endpoint: unregisters SW and clears caches from the client
app.get('/api/clear-cache', (_req, res) => {
  res.type('html').send(`<!doctype html><html><body><script>
(async()=>{
  const regs=await navigator.serviceWorker.getRegistrations();
  for(const r of regs) await r.unregister();
  const keys=await caches.keys();
  for(const k of keys) await caches.delete(k);
  document.body.innerText='Caches cleared, SW unregistered. Redirecting...';
  setTimeout(()=>location.href='/',1500);
})();
</script></body></html>`);
});

app.use(express.static(clientDist));
app.get('*splat', (_req, res) => {
  const indexPath = path.join(clientDist, 'index.html');
  res.type('html');
  fs.createReadStream(indexPath).pipe(res);
});

// Start server
const server = app.listen(PORT, () => {
  console.log(`[Server] Listening on port ${PORT}`);
  console.log(`[Server] Content root: ${contentRoot}`);
  console.log(`[Server] Agents: ${Object.keys(config.agents).join(', ')}`);

  // Start voice service health checks
  startVoiceHealthChecks();

  // Connect to gateway
  gateway.connect();
});

// Graceful shutdown
function shutdown() {
  console.log('[Server] Shutting down...');
  stopVoiceHealthChecks();
  gateway.disconnect();
  db.close();
  server.close(() => {
    console.log('[Server] Stopped');
    process.exit(0);
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
