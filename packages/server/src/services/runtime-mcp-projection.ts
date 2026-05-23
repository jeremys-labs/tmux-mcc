import fs from 'fs';
import path from 'path';

export type McpServerConfig = {
  command?: string;
  args?: string[];
  type?: string;
  url?: string;
  headers?: Record<string, string>;
};

export type McpConfig = {
  mcpServers?: Record<string, McpServerConfig>;
};

export type RuntimeMcpProjectionInput = {
  agent: string;
  agentDir: string;
  agentsRoot?: string;
  openBrainRoot?: string;
};

export type RuntimeMcpProjectionResult = {
  mcpPath: string;
  projectedServers: string[];
};

const OPEN_BRAIN_SERVER_NAME = 'open-brain';
const BLUEBUBBLES_SERVER_NAME = 'plugin_bluebubbles';
const DEFAULT_AGENTS_ROOT = '/Volumes/Repo-Drive/agents';
const DEFAULT_OPEN_BRAIN_ROOT = '/Volumes/Repo-Drive/src/open-brain';
const DEFAULT_BLUEBUBBLES_ROOT = '/Volumes/Repo-Drive/src/bluebubbles-channel';
const DEFAULT_BLUEBUBBLES_STATE_DIR = '/Users/jeremylahners/.claude/channels/bluebubbles';

function fileExists(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function readMcpConfig(mcpPath: string): McpConfig {
  try {
    return JSON.parse(fs.readFileSync(mcpPath, 'utf8')) as McpConfig;
  } catch {
    return { mcpServers: {} };
  }
}

function writeExecutable(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, { mode: 0o755 });
  fs.chmodSync(filePath, 0o755);
}

function openBrainWrapper(agent: string, agentsRoot: string, openBrainRoot: string): string {
  return [
    '#!/usr/bin/env zsh',
    'set -euo pipefail',
    '',
    `source ${openBrainRoot}/credentials/ob1.env`,
    `source ${agentsRoot}/${agent}/.open-brain/memory.env`,
    '',
    `MCP_ACCESS_KEY="$(head -n 1 ${openBrainRoot}/credentials/mcp-access-key.txt | tr -d '\\n')"`,
    'URL="${SUPABASE_PROJECT_URL}/functions/v1/open-brain-mcp?key=${MCP_ACCESS_KEY}&agent_key=${AGENT_MEMORY_KEY}"',
    '',
    'exec npx -y mcp-remote "$URL"',
    '',
  ].join('\n');
}

function blueBubblesWrapper(blueBubblesRoot: string, blueBubblesStateDir: string): string {
  return [
    '#!/usr/bin/env zsh',
    'set -euo pipefail',
    '',
    `export BB_STATE_DIR=${blueBubblesStateDir}`,
    'export BLUEBUBBLES_WEBHOOK_ENABLED=0',
    '',
    `cd ${blueBubblesRoot}`,
    'exec /opt/homebrew/bin/bun server.ts',
    '',
  ].join('\n');
}

function shouldProjectBlueBubbles(agent: string): boolean {
  const allowedAgents = process.env.BLUEBUBBLES_MCP_AGENTS
    ?.split(',')
    .map(value => value.trim())
    .filter(Boolean);

  return allowedAgents ? allowedAgents.includes(agent) : agent === 'isla';
}

export function projectRuntimeMcpServers(input: RuntimeMcpProjectionInput): RuntimeMcpProjectionResult {
  const agentsRoot = input.agentsRoot ?? DEFAULT_AGENTS_ROOT;
  const openBrainRoot = input.openBrainRoot ?? DEFAULT_OPEN_BRAIN_ROOT;
  const blueBubblesRoot = process.env.BLUEBUBBLES_CHANNEL_ROOT ?? DEFAULT_BLUEBUBBLES_ROOT;
  const blueBubblesStateDir = process.env.BLUEBUBBLES_STATE_DIR ?? DEFAULT_BLUEBUBBLES_STATE_DIR;
  const mcpPath = path.join(input.agentDir, '.mcp.json');
  const config = readMcpConfig(mcpPath);
  const mcpServers = { ...(config.mcpServers ?? {}) };
  const projectedServers: string[] = [];

  // Discord now routes both inbound and outbound through the shared bridge.
  // Remove the legacy per-agent direct Discord MCP if it exists from older
  // projections; it creates a second network path and can starve the bridge.
  delete mcpServers.plugin_discord_discord;

  const openBrainMemoryPath = path.join(input.agentDir, '.open-brain', 'memory.env');
  const openBrainEnvPath = path.join(openBrainRoot, 'credentials', 'ob1.env');
  const openBrainAccessKeyPath = path.join(openBrainRoot, 'credentials', 'mcp-access-key.txt');
  if (fileExists(openBrainMemoryPath) && fileExists(openBrainEnvPath) && fileExists(openBrainAccessKeyPath)) {
    const wrapperPath = path.join(input.agentDir, 'bin', 'open-brain-mcp-wrapper');
    writeExecutable(wrapperPath, openBrainWrapper(input.agent, agentsRoot, openBrainRoot));
    mcpServers[OPEN_BRAIN_SERVER_NAME] = {
      command: wrapperPath,
      type: 'stdio',
    };
    projectedServers.push(OPEN_BRAIN_SERVER_NAME);
  }

  const blueBubblesServerPath = path.join(blueBubblesRoot, 'server.ts');
  const blueBubblesEnvPath = path.join(blueBubblesStateDir, '.env');
  if (shouldProjectBlueBubbles(input.agent) && fileExists(blueBubblesServerPath) && fileExists(blueBubblesEnvPath)) {
    const wrapperPath = path.join(input.agentDir, 'bin', 'bluebubbles-mcp-wrapper');
    writeExecutable(wrapperPath, blueBubblesWrapper(blueBubblesRoot, blueBubblesStateDir));
    mcpServers[BLUEBUBBLES_SERVER_NAME] = {
      command: wrapperPath,
      type: 'stdio',
    };
    projectedServers.push(BLUEBUBBLES_SERVER_NAME);
  }

  fs.writeFileSync(
    mcpPath,
    `${JSON.stringify({ ...config, mcpServers }, null, 2)}\n`,
  );

  return { mcpPath, projectedServers };
}
