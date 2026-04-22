import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadCodexBridgeConfig, normalizeCodexBridgeBindings } from './codex-bridge-config.js';

describe('loadCodexBridgeConfig', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-bridge-config-'));
    delete process.env.CODEX_BRIDGE_AGENT_KEY;
    delete process.env.CODEX_BRIDGE_DISCORD_STATE_DIR;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.CODEX_BRIDGE_AGENT_KEY;
    delete process.env.CODEX_BRIDGE_DISCORD_STATE_DIR;
  });

  it('loads explicit bridge config json when present', () => {
    fs.mkdirSync(path.join(tmpDir, 'bridge'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'bridge', 'codex-discord.json'),
      JSON.stringify({
        subscriptions: [{ agentKey: 'zara', channelId: '1492551894214905886' }],
      }),
    );

    const config = loadCodexBridgeConfig(tmpDir);
    expect(config?.subscriptions[0]?.agentKey).toBe('zara');
  });

  it('normalizes a multi-binding config without collapsing bindings', () => {
    const bindings = normalizeCodexBridgeBindings({
      bindings: [
        {
          name: 'zara',
          tokenEnvVar: 'DISCORD_BOT_TOKEN_ZARA',
          subscriptions: [{ agentKey: 'zara', channelId: '1492551894214905886' }],
        },
        {
          name: 'marcus',
          tokenEnvVar: 'DISCORD_BOT_TOKEN_MARCUS',
          subscriptions: [{ agentKey: 'marcus', channelId: '1492892431543308439' }],
        },
      ],
      subscriptions: [],
    });

    expect(bindings).toHaveLength(2);
    expect(bindings.map((binding) => binding.name)).toEqual(['zara', 'marcus']);
  });

  it('derives config from an agent discord access.json when env vars are set', () => {
    const discordStateDir = path.join(tmpDir, 'zara-discord');
    fs.mkdirSync(discordStateDir, { recursive: true });
    fs.writeFileSync(
      path.join(discordStateDir, 'access.json'),
      JSON.stringify({
        groups: {
          '1492551894214905886': { requireMention: false },
        },
      }),
    );

    process.env.CODEX_BRIDGE_AGENT_KEY = 'zara';
    process.env.CODEX_BRIDGE_DISCORD_STATE_DIR = discordStateDir;

    const config = loadCodexBridgeConfig(tmpDir);
    expect(config?.subscriptions).toEqual([
      { agentKey: 'zara', channelId: '1492551894214905886' },
    ]);
  });
});
