import { describe, expect, it } from 'vitest';
import { parseRuntimeWrapperArgs } from './runtime-wrapper-args.js';

describe('runtime wrapper args', () => {
  it('parses shared wrapper flags and preserves Claude runtime args', () => {
    expect(parseRuntimeWrapperArgs([
      '--agent',
      'enzo',
      '--cd',
      '/Volumes/Repo-Drive/agents/enzo',
      '--channels',
      'plugin:discord@claude-plugins-official',
      '--dangerously-skip-permissions',
    ], { defaultCwd: '/tmp/default' })).toEqual({
      agentKey: 'enzo',
      cwd: '/Volumes/Repo-Drive/agents/enzo',
      runtimeArgs: [
        '--channels',
        'plugin:discord@claude-plugins-official',
        '--dangerously-skip-permissions',
      ],
    });
  });

  it('forwards only args after the Codex separator when configured', () => {
    expect(parseRuntimeWrapperArgs([
      '--agent',
      'enzo',
      '--cd',
      '/Volumes/Repo-Drive/agents/enzo',
      '--',
      '--dangerously-bypass-approvals-and-sandbox',
    ], { defaultCwd: '/tmp/default', forwardAfterDoubleDash: true })).toEqual({
      agentKey: 'enzo',
      cwd: '/Volumes/Repo-Drive/agents/enzo',
      runtimeArgs: ['--dangerously-bypass-approvals-and-sandbox'],
    });
  });

  it('throws when agent key is missing', () => {
    expect(() => parseRuntimeWrapperArgs(['--cd', '/tmp/agent'])).toThrow('Missing required --agent <agentKey>');
  });
});
