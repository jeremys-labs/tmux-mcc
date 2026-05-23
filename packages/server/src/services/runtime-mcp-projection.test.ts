import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { projectRuntimeMcpServers } from './runtime-mcp-projection.js';

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

describe('runtime MCP projection', () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
    delete process.env.BLUEBUBBLES_CHANNEL_ROOT;
    delete process.env.BLUEBUBBLES_STATE_DIR;
    delete process.env.BLUEBUBBLES_MCP_AGENTS;
  });

  function makeFixture(agent = 'hercule') {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-mcp-projection-'));
    tempRoots.push(root);
    const agentsRoot = path.join(root, 'agents');
    const openBrainRoot = path.join(root, 'open-brain');
    const agentDir = path.join(agentsRoot, agent);

    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(path.join(openBrainRoot, 'credentials'), { recursive: true });
    fs.writeFileSync(path.join(openBrainRoot, 'credentials', 'ob1.env'), 'SUPABASE_PROJECT_URL=https://example.supabase.co\n');
    fs.writeFileSync(path.join(openBrainRoot, 'credentials', 'mcp-access-key.txt'), 'first-line-key\nstray-line\n');

    return { agent, agentsRoot, openBrainRoot, agentDir };
  }

  it('removes legacy direct Discord MCP and projects Open Brain while preserving custom entries', () => {
    const fixture = makeFixture();
    writeJson(path.join(fixture.agentDir, '.mcp.json'), {
      mcpServers: {
        simplefunctions: {
          type: 'http',
          url: 'https://simplefunctions.test/mcp',
        },
        plugin_discord_discord: {
          command: path.join(fixture.agentDir, 'bin', 'discord-mcp-wrapper'),
          type: 'stdio',
        },
      },
    });
    writeJson(path.join(fixture.agentDir, '.claude', 'discord', 'access.json'), { groups: { dm: {} } });
    fs.mkdirSync(path.join(fixture.agentDir, '.open-brain'), { recursive: true });
    fs.writeFileSync(path.join(fixture.agentDir, '.open-brain', 'memory.env'), 'AGENT_MEMORY_AGENT_ID=hercule\nAGENT_MEMORY_KEY=amk_test\n');

    const result = projectRuntimeMcpServers(fixture);
    const config = readJson<{
      mcpServers: Record<string, { command?: string; type?: string; url?: string }>;
    }>(path.join(fixture.agentDir, '.mcp.json'));

    expect(result.projectedServers).toEqual(['open-brain']);
    expect(config.mcpServers.simplefunctions.url).toBe('https://simplefunctions.test/mcp');
    expect(config.mcpServers.plugin_discord_discord).toBeUndefined();
    expect(config.mcpServers['open-brain']).toEqual({
      command: path.join(fixture.agentDir, 'bin', 'open-brain-mcp-wrapper'),
      type: 'stdio',
    });
    expect(fs.statSync(path.join(fixture.agentDir, 'bin', 'open-brain-mcp-wrapper')).mode & 0o111).not.toBe(0);
    expect(fs.readFileSync(path.join(fixture.agentDir, 'bin', 'open-brain-mcp-wrapper'), 'utf8')).toContain('head -n 1');
  });

  it('does not add Open Brain when the agent has no memory key', () => {
    const fixture = makeFixture('jordan');
    writeJson(path.join(fixture.agentDir, '.mcp.json'), {
      mcpServers: {
        simplefunctions: {
          type: 'http',
          url: 'https://simplefunctions.test/mcp',
        },
      },
    });

    const result = projectRuntimeMcpServers(fixture);
    const config = readJson<{ mcpServers: Record<string, unknown> }>(path.join(fixture.agentDir, '.mcp.json'));

    expect(result.projectedServers).toEqual([]);
    expect(config.mcpServers).toEqual({
      simplefunctions: {
        type: 'http',
        url: 'https://simplefunctions.test/mcp',
      },
    });
  });

  it('projects BlueBubbles MCP for Isla in outbound-only mode', () => {
    const fixture = makeFixture('isla');
    const blueBubblesRoot = path.join(fixture.agentsRoot, '..', 'bluebubbles-channel');
    const blueBubblesStateDir = path.join(fixture.agentsRoot, '..', 'bluebubbles-state');
    fs.mkdirSync(blueBubblesRoot, { recursive: true });
    fs.mkdirSync(blueBubblesStateDir, { recursive: true });
    fs.writeFileSync(path.join(blueBubblesRoot, 'server.ts'), 'server');
    fs.writeFileSync(path.join(blueBubblesStateDir, '.env'), 'BLUEBUBBLES_PASSWORD=test\n');
    process.env.BLUEBUBBLES_CHANNEL_ROOT = blueBubblesRoot;
    process.env.BLUEBUBBLES_STATE_DIR = blueBubblesStateDir;

    const result = projectRuntimeMcpServers(fixture);
    const config = readJson<{
      mcpServers: Record<string, { command?: string; type?: string }>;
    }>(path.join(fixture.agentDir, '.mcp.json'));
    const wrapperPath = path.join(fixture.agentDir, 'bin', 'bluebubbles-mcp-wrapper');

    expect(result.projectedServers).toEqual(['plugin_bluebubbles']);
    expect(config.mcpServers.plugin_bluebubbles).toEqual({
      command: wrapperPath,
      type: 'stdio',
    });
    expect(fs.statSync(wrapperPath).mode & 0o111).not.toBe(0);
    expect(fs.readFileSync(wrapperPath, 'utf8')).toContain('BLUEBUBBLES_WEBHOOK_ENABLED=0');
  });
});
