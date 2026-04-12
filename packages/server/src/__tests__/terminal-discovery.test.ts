import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execFileSync } from 'child_process';
import { listTmuxAgents } from '../services/tmux-relay.js';

vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
}));

describe('listTmuxAgents', () => {
  beforeEach(() => {
    vi.mocked(execFileSync).mockReset();
  });

  it('parses tmux list-windows output into agent names', () => {
    vi.mocked(execFileSync).mockReturnValue('marcus\nisla\nharper\n' as any);

    const agents = listTmuxAgents('agents');

    expect(agents).toEqual(['marcus', 'isla', 'harper']);
  });

  it('returns empty array when session does not exist', () => {
    vi.mocked(execFileSync).mockImplementation(() => { throw new Error('no server running'); });

    const agents = listTmuxAgents('agents');

    expect(agents).toEqual([]);
  });

  it('filters out empty lines from tmux output', () => {
    vi.mocked(execFileSync).mockReturnValue('\nmarcus\n\nisla\n' as any);

    const agents = listTmuxAgents('agents');

    expect(agents).toEqual(['marcus', 'isla']);
  });
});
