import os from 'os';
import path from 'path';

export const SUPPORTED_RUNTIMES = ['claude', 'codex'] as const;
export type SupportedRuntime = (typeof SUPPORTED_RUNTIMES)[number];

export type RuntimeLaunchPlanInput = {
  agent: string;
  agentDir: string;
  runtime: SupportedRuntime;
  mccRoot?: string;
  homeDir?: string;
  model?: string;
  env?: NodeJS.ProcessEnv;
};

export type RuntimeLaunchPlan = {
  agent: string;
  runtime: SupportedRuntime;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
};

const DEFAULT_AGENT_MEMORY_SERVICE_URL = 'http://127.0.0.1:4317';
const DEFAULT_AGENT_MEMORY_SERVICE_MODE = 'service';

// Resolves the agent-memory service env injected into each launched runtime.
// Defaults to the live service in authoritative `service` mode, but lets the
// harness environment override the URL/mode so a cutover can be staged safely
// (e.g. AGENT_MEMORY_SERVICE_MODE=shadow to validate retrieval parity against
// the embedded path before flipping the service authoritative).
function resolveServiceMemoryEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const serviceEnv: Record<string, string> = {
    AGENT_MEMORY_SERVICE_URL: env.AGENT_MEMORY_SERVICE_URL ?? DEFAULT_AGENT_MEMORY_SERVICE_URL,
    AGENT_MEMORY_SERVICE_MODE: env.AGENT_MEMORY_SERVICE_MODE ?? DEFAULT_AGENT_MEMORY_SERVICE_MODE,
  };
  if (env.AGENT_MEMORY_SERVICE_TOKEN) {
    serviceEnv.AGENT_MEMORY_SERVICE_TOKEN = env.AGENT_MEMORY_SERVICE_TOKEN;
  }
  return serviceEnv;
}

export function parseSupportedRuntime(value: string): SupportedRuntime {
  if (value === 'claude' || value === 'codex') return value;
  throw new Error(`Unsupported runtime: ${value}`);
}

export function buildRuntimeLaunchPlan(input: RuntimeLaunchPlanInput): RuntimeLaunchPlan {
  const mccRoot = input.mccRoot ?? path.resolve(import.meta.dirname, '../../../..');
  const homeDir = input.homeDir ?? os.homedir();
  const serviceMemoryEnv = resolveServiceMemoryEnv(input.env ?? process.env);
  const baseArgs = [
    'run',
    input.runtime === 'claude' ? 'run:claude-wrapper' : 'run:codex-wrapper',
    '--workspace=@mcc-tmux/server',
    '--prefix',
    mccRoot,
    '--',
    '--agent',
    input.agent,
    '--cd',
    input.agentDir,
  ];

  if (input.runtime === 'claude') {
    const claudeArgs = ['--dangerously-skip-permissions'];
    if (input.model) claudeArgs.push('--model', input.model);
    return {
      agent: input.agent,
      runtime: input.runtime,
      command: 'npm',
      args: [...baseArgs, ...claudeArgs],
      cwd: input.agentDir,
      env: {
        CONTENT_ROOT: path.join(homeDir, '.tmux-mcc'),
        ...serviceMemoryEnv,
      },
    };
  }

  return {
    agent: input.agent,
    runtime: input.runtime,
    command: 'npm',
    args: [
      ...baseArgs,
      '--',
      '--dangerously-bypass-approvals-and-sandbox',
    ],
    cwd: input.agentDir,
    env: {
      CONTENT_ROOT: path.join(homeDir, '.tmux-mcc'),
      ...serviceMemoryEnv,
    },
  };
}
