import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  buildRuntimeLaunchPlan,
  parseSupportedRuntime,
} from './runtime-launch-plan.js';

describe('runtime launch plan', () => {
  const agentDir = '/Volumes/Repo-Drive/agents/enzo';
  const mccRoot = '/Volumes/Repo-Drive/src/mcc-tmux';

  it('builds the Enzo Claude adapter plan with Discord channel injection', () => {
    const plan = buildRuntimeLaunchPlan({
      agent: 'enzo',
      agentDir,
      runtime: 'claude',
      mccRoot,
    });

    expect(plan).toMatchObject({
      agent: 'enzo',
      runtime: 'claude',
      command: 'npm',
      cwd: agentDir,
      env: {
        DISCORD_STATE_DIR: path.join(agentDir, '.claude', 'discord'),
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
      '--channels',
      'plugin:discord@claude-plugins-official',
      '--dangerously-skip-permissions',
    ]);
  });

  it('builds the Enzo Codex adapter plan with Codex-only forwarded args', () => {
    const plan = buildRuntimeLaunchPlan({
      agent: 'enzo',
      agentDir,
      runtime: 'codex',
      mccRoot,
      homeDir: '/Users/jeremy',
    });

    expect(plan).toMatchObject({
      agent: 'enzo',
      runtime: 'codex',
      command: 'npm',
      cwd: agentDir,
      env: {
        CONTENT_ROOT: '/Users/jeremy/.tmux-mcc',
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
