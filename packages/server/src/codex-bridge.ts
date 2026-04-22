import { resolveContentRoot } from './config.js';
import { ensureContentDirs } from './content.js';
import { loadCodexBridgeConfig, normalizeCodexBridgeBindings } from './codex-bridge-config.js';
import { DiscordGatewayClient } from './services/discord-gateway-client.js';
import { appendInboxEntry, hasSeen, markSeen } from './services/codex-bridge-store.js';
import { routeDiscordMessageForBinding } from './services/codex-bridge-router.js';

const contentRoot = resolveContentRoot();
ensureContentDirs(contentRoot);

const config = loadCodexBridgeConfig(contentRoot);
if (!config) {
  console.error('[codex-bridge] missing config file at bridge/codex-discord.json');
  process.exit(1);
}

const bindings = normalizeCodexBridgeBindings(config);
const clients: DiscordGatewayClient[] = [];

for (const binding of bindings) {
  const token = process.env[binding.tokenEnvVar];
  if (!token) {
    console.error(`[codex-bridge] missing Discord token in env var ${binding.tokenEnvVar} for binding ${binding.name}`);
    process.exit(1);
  }

  const client = new DiscordGatewayClient(token, (event) => {
    const routed = routeDiscordMessageForBinding(binding, event);
    if (!routed) return;

    const subscriptionKey = `${binding.name}:${routed.agentKey}:${routed.threadId ?? routed.channelId}`;
    if (hasSeen(contentRoot, subscriptionKey, routed.id)) return;

    const filePath = appendInboxEntry(contentRoot, routed);
    markSeen(contentRoot, subscriptionKey, routed.id);
    console.log(`[codex-bridge] [${binding.name}] queued ${routed.id} for ${routed.agentKey} -> ${filePath}`);
  });

  client.connect();
  clients.push(client);
  console.log(`[codex-bridge] connected binding ${binding.name}`);
}

process.on('SIGINT', () => {
  for (const client of clients) client.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  for (const client of clients) client.close();
  process.exit(0);
});
