import fs from 'fs';
import path from 'path';
import { projectRuntimeMcpServers } from './runtime-mcp-projection.js';
import { parseSupportedRuntime, type SupportedRuntime } from './runtime-launch-plan.js';

export type ScheduledRuntimeJobInput = {
  agent: string;
  agentDir: string;
  runtime: SupportedRuntime;
  prompt: string;
  model?: string;
  appendSystemPrompt?: string;
  discordStateDir?: string;
  scheduledJobId?: string;
  scheduledJobLabel?: string;
  awaitingReply?: boolean;
  /** Only use for an explicitly vetted job that requires host capabilities. */
  bypassSandbox?: boolean;
  claudeBin?: string;
  codexBin?: string;
};

export type ScheduledRuntimeJobPlan = {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
};

const DEFAULT_CLAUDE_BIN = '/opt/homebrew/bin/claude';
const DEFAULT_CODEX_BIN = '/opt/homebrew/bin/codex';
const DISCORD_FALLBACK_DENY_TOOLS = [
  'Bash(*.claude/discord/.env*)',
  'Bash(*DISCORD_BOT_TOKEN*)',
  'Bash(*discord.com/api*)',
];

export function readAgentRuntime(agentDir: string, fallback = 'claude'): SupportedRuntime {
  const runtimePath = path.join(agentDir, '.runtime');
  try {
    return parseSupportedRuntime(fs.readFileSync(runtimePath, 'utf8').trim());
  } catch {
    return parseSupportedRuntime(fallback);
  }
}

export function runtimeFromExecutor(executor: string | undefined, agentDir: string): SupportedRuntime {
  if (executor === 'claude' || executor === 'codex') return executor;
  return readAgentRuntime(agentDir);
}

export function buildScheduledRuntimeJobPlan(input: ScheduledRuntimeJobInput): ScheduledRuntimeJobPlan {
  const env: Record<string, string> = {};
  if (input.discordStateDir) {
    env.DISCORD_STATE_DIR = input.discordStateDir;
  }
  if (input.scheduledJobId) {
    env.SCHEDULED_JOB_ID = input.scheduledJobId;
    env.SCHEDULED_DISCORD_SOURCE = 'scheduled_runtime';
  }
  if (input.scheduledJobLabel) {
    env.SCHEDULED_JOB_LABEL = input.scheduledJobLabel;
  }
  if (input.awaitingReply) {
    env.SCHEDULED_AWAITING_REPLY = '1';
  }

  if (input.runtime === 'codex') {
    const modelArgs = input.model ? ['-m', input.model] : [];
    const prompt = input.appendSystemPrompt
      ? `${input.appendSystemPrompt}\n\n${input.prompt}`
      : input.prompt;
    const sandboxArgs = input.bypassSandbox
      ? ['--dangerously-bypass-approvals-and-sandbox']
      : [];
    return {
      command: input.codexBin ?? DEFAULT_CODEX_BIN,
      args: ['-a', 'never', ...modelArgs, '-C', input.agentDir, 'exec', '--skip-git-repo-check', ...sandboxArgs, prompt],
      cwd: input.agentDir,
      env,
    };
  }

  projectRuntimeMcpServers({
    agent: input.agent,
    agentDir: input.agentDir,
  });

  const mcpConfigPath = path.join(input.agentDir, '.mcp.json');
  const mcpArgs = fs.existsSync(mcpConfigPath) ? ['--mcp-config', mcpConfigPath] : [];
  const appendArgs = input.appendSystemPrompt
    ? ['--append-system-prompt', input.appendSystemPrompt]
    : [];
  const discordDenyArgs = input.discordStateDir
    ? ['--disallowedTools', DISCORD_FALLBACK_DENY_TOOLS.join(',')]
    : [];
  const modelArgs = input.model ? ['--model', input.model] : [];

  return {
    command: input.claudeBin ?? DEFAULT_CLAUDE_BIN,
    args: [
      '--print',
      '--permission-mode',
      'bypassPermissions',
      ...mcpArgs,
      ...appendArgs,
      ...discordDenyArgs,
      ...modelArgs,
      '--',
      input.prompt,
    ],
    cwd: input.agentDir,
    env,
  };
}
