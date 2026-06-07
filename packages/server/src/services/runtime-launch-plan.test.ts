import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  buildRuntimeLaunchPlan,
  parseSupportedRuntime,
} from './runtime-launch-plan.js';

describe('runtime launch plan', () => {
  const agentDir = '/Volumes/Repo-Drive/agents/enzo';
  const mccRoot = '/Volumes/Repo-Drive/src/mcc-tmux';

  it('builds the Enzo Claude adapter plan using inbox-based Discord delivery', () => {
    const plan = buildRuntimeLaunchPlan({
      agent: 'enzo',
      agentDir,
      runtime: 'claude',
      mccRoot,
      homeDir: '/Users/jeremy',
      env: {},
    });

    expect(plan).toMatchObject({
      agent: 'enzo',
      runtime: 'claude',
      command: 'npm',
      cwd: agentDir,
      env: {
        CONTENT_ROOT: '/Users/jeremy/.tmux-mcc',
        AGENT_MEMORY_SERVICE_URL: 'http://127.0.0.1:4317',
        AGENT_MEMORY_SERVICE_MODE: 'service',
      },
    });
    expect(plan.args).toEqual([
      'run',
      'run:claude-wrapper',
      '--workspace=@mcc-tmux/server',
      '--prefix',
      mccRoot,
      '--',
      '--agent',
      'enzo',
      '--cd',
      agentDir,
      '--dangerously-skip-permissions',
    ]);
  });

  it('appends --model to Claude args when model is specified', () => {
    const plan = buildRuntimeLaunchPlan({
      agent: 'enzo',
      agentDir,
      runtime: 'claude',
      mccRoot,
      homeDir: '/Users/jeremy',
      model: 'claude-haiku-4-5-20251001',
    });

    expect(plan.args).toContain('--model');
    expect(plan.args).toContain('claude-haiku-4-5-20251001');
    expect(plan.args.indexOf('--model')).toBe(plan.args.indexOf('claude-haiku-4-5-20251001') - 1);
  });

  it('builds the Enzo Codex adapter plan with Codex-only forwarded args', () => {
    const plan = buildRuntimeLaunchPlan({
      agent: 'enzo',
      agentDir,
      runtime: 'codex',
      mccRoot,
      homeDir: '/Users/jeremy',
      env: {},
    });

    expect(plan).toMatchObject({
      agent: 'enzo',
      runtime: 'codex',
      command: 'npm',
      cwd: agentDir,
      env: {
        CONTENT_ROOT: '/Users/jeremy/.tmux-mcc',
        AGENT_MEMORY_SERVICE_URL: 'http://127.0.0.1:4317',
        AGENT_MEMORY_SERVICE_MODE: 'service',
      },
    });
    expect(plan.args).toEqual([
      'run',
      'run:codex-wrapper',
      '--workspace=@mcc-tmux/server',
      '--prefix',
      mccRoot,
      '--',
      '--agent',
      'enzo',
      '--cd',
      agentDir,
      '--',
      '--dangerously-bypass-approvals-and-sandbox',
    ]);
  });

  it('lets the harness env stage the memory-service mode (shadow-first cutover)', () => {
    const plan = buildRuntimeLaunchPlan({
      agent: 'enzo',
      agentDir,
      runtime: 'claude',
      mccRoot,
      homeDir: '/Users/jeremy',
      env: {
        AGENT_MEMORY_SERVICE_MODE: 'shadow',
        AGENT_MEMORY_SERVICE_URL: 'http://127.0.0.1:4317',
        AGENT_MEMORY_SERVICE_TOKEN: 'staging-token',
      },
    });

    expect(plan.env).toMatchObject({
      AGENT_MEMORY_SERVICE_URL: 'http://127.0.0.1:4317',
      AGENT_MEMORY_SERVICE_MODE: 'shadow',
      AGENT_MEMORY_SERVICE_TOKEN: 'staging-token',
    });
  });

  it('omits the service token when the harness env does not set one', () => {
    const plan = buildRuntimeLaunchPlan({
      agent: 'enzo',
      agentDir,
      runtime: 'claude',
      mccRoot,
      homeDir: '/Users/jeremy',
      env: {},
    });

    expect(plan.env).not.toHaveProperty('AGENT_MEMORY_SERVICE_TOKEN');
  });

  it('rejects unsupported runtimes before launch', () => {
    expect(() => parseSupportedRuntime('pi')).toThrow('Unsupported runtime: pi');
  });

  it('defaults the wrapper --prefix to the mcc-tmux repo root', () => {
    const plan = buildRuntimeLaunchPlan({
      agent: 'enzo',
      agentDir,
      runtime: 'claude',
    });
    const defaultMccRoot = path.resolve(import.meta.dirname, '../../../..');

    expect(plan.args).toContain(defaultMccRoot);
    expect(defaultMccRoot.endsWith('/packages')).toBe(false);
  });
});
