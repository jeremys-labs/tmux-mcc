import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { createServer } from 'http';
import { loadConfig, resolveContentRoot } from './config.js';
import { ensureContentDirs } from './content.js';
import { loadAgentModels } from './models.js';
import { createChatDB } from './db.js';
import { createConfigRouter } from './routes/config.js';
import { createHealthRouter } from './routes/health.js';
import { createFileRoutes } from './routes/files.js';
import { createStandupRoutes } from './routes/standup.js';
import { createChannelRoutes } from './routes/channels.js';
import { createAgentDataRoutes } from './routes/agent-data.js';
import { createVoiceRouter, startVoiceHealthChecks, stopVoiceHealthChecks } from './routes/voice.js';
import { createProjectsRouter } from './routes/projects.js';
import { createSearchRouter } from './routes/search.js';
import { terminalRouter, handleUpgrade } from './routes/terminal.js';

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

// Express app
const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Mount routes
app.use('/api', createHealthRouter());
app.use('/api', createConfigRouter(config));
app.use('/api', createFileRoutes(contentRoot));
app.use('/api', createStandupRoutes(contentRoot));
app.use('/api', createChannelRoutes(contentRoot));
app.use('/api', createAgentDataRoutes(config, contentRoot));
app.use('/api', createVoiceRouter(config));
app.use('/api', createProjectsRouter(contentRoot));
app.use('/api/search', createSearchRouter(db));
app.use('/api/terminal', terminalRouter);

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
const server = createServer(app);

server.on('upgrade', (request, socket, head) => {
  handleUpgrade(request, socket, head as Buffer);
});

server.listen(PORT, () => {
  console.log(`[server] listening on :${PORT}`);
  console.log(`[server] tmux session: ${process.env.TMUX_SESSION ?? 'agents'}`);
  console.log(`[Server] Content root: ${contentRoot}`);
  console.log(`[Server] Agents: ${Object.keys(config.agents).join(', ')}`);

  // Start voice service health checks
  startVoiceHealthChecks();
});

// Graceful shutdown
function shutdown() {
  console.log('[Server] Shutting down...');
  stopVoiceHealthChecks();
  db.close();
  server.close(() => {
    console.log('[Server] Stopped');
    process.exit(0);
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
