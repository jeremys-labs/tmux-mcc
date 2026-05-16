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
};

export type RuntimeLaunchPlan = {
  agent: string;
  runtime: SupportedRuntime;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
};

export function parseSupportedRuntime(value: string): SupportedRuntime {
  if (value === 'claude' || value === 'codex') return value;
  throw new Error(`Unsupported runtime: ${value}`);
}

export function buildRuntimeLaunchPlan(input: RuntimeLaunchPlanInput): RuntimeLaunchPlan {
  const mccRoot = input.mccRoot ?? path.resolve(import.meta.dirname, '../../../..');
  const homeDir = input.homeDir ?? os.homedir();
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
    },
  };
}
