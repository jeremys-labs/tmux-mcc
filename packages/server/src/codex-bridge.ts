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
const backfillIntervalMs = Number.parseInt(process.env.DISCORD_BRIDGE_BACKFILL_INTERVAL_MS ?? '15000', 10);

function subscriptionKeyFor(bindingName: string, agentKey: string, channelId: string): string {
  return `${bindingName}:${agentKey}:${channelId}`;
}

function routeAndAppend(binding: (typeof bindings)[number], event: Parameters<typeof routeDiscordMessageForBinding>[1]): void {
  const routed = routeDiscordMessageForBinding(binding, event);
  if (!routed) return;

  const subscriptionKey = subscriptionKeyFor(binding.name, routed.agentKey, routed.threadId ?? routed.channelId);
  if (hasSeen(contentRoot, subscriptionKey, routed.id)) return;

  const filePath = appendInboxEntry(contentRoot, routed);
  markSeen(contentRoot, subscriptionKey, routed.id);
  console.log(`[codex-bridge] [${binding.name}] queued ${routed.id} for ${routed.agentKey} -> ${filePath}`);
}

async function backfillBinding(binding: (typeof bindings)[number], token: string): Promise<void> {
  for (const subscription of binding.subscriptions) {
    const response = await fetch(`https://discord.com/api/v10/channels/${subscription.channelId}/messages?limit=10`, {
      headers: { Authorization: `Bot ${token}` },
    });
    if (!response.ok) {
      console.error(`[codex-bridge] [${binding.name}] backfill failed for ${subscription.channelId}: ${response.status} ${await response.text()}`);
      continue;
    }

    const events = (await response.json() as Parameters<typeof routeDiscordMessageForBinding>[1][]).reverse();
    for (const event of events) {
      routeAndAppend(binding, event);
    }
  }
}

for (const binding of bindings) {
  const token = process.env[binding.tokenEnvVar];
  if (!token) {
    console.error(`[codex-bridge] missing Discord token in env var ${binding.tokenEnvVar} for binding ${binding.name}`);
    process.exit(1);
  }

  const client = new DiscordGatewayClient(token, (event) => routeAndAppend(binding, event));

  client.connect();
  clients.push(client);
  console.log(`[codex-bridge] connected binding ${binding.name}`);

  if (Number.isFinite(backfillIntervalMs) && backfillIntervalMs > 0) {
    setInterval(() => {
      void backfillBinding(binding, token).catch((error) => {
        console.error(`[codex-bridge] [${binding.name}] backfill error:`, error);
      });
    }, backfillIntervalMs);
  }
}

process.on('SIGINT', () => {
  for (const client of clients) client.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  for (const client of clients) client.close();
  process.exit(0);
});
