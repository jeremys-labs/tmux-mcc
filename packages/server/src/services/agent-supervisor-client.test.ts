import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchAgentSupervisorStatus, planAgentSupervisorCommand } from './agent-supervisor-client.js';

afterEach(() => vi.unstubAllGlobals());

describe('agent supervisor client', () => {
  it('reads supervisor-owned fleet status', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({
        mode: 'observe-only',
        agents: [{ agent: 'zara', runtime: 'claude', process: { status: 'running', pid: 1 }, progress: { status: 'idle', detail: 'last turn completed' } }],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchAgentSupervisorStatus();

    expect(result.agents[0]).toMatchObject({ agent: 'zara', process: { status: 'running' } });
    expect(fetchMock.mock.calls[0][0].toString()).toBe('http://127.0.0.1:4318/v1/agents');
  });

  it('surfaces supervisor outages instead of inventing fleet health', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    await expect(fetchAgentSupervisorStatus()).rejects.toThrow('fetch failed');
  });

  it('requests dry-run command plans without executing lifecycle actions', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({
        requestId: 'req-1',
        mode: 'dry-run',
        operation: 'restart',
        agent: 'zara',
        currentRuntime: 'claude',
        targetRuntime: 'claude',
        proposedCommand: ['tmux', 'respawn-pane'],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await planAgentSupervisorCommand({
      requestId: 'req-1',
      operation: 'restart',
      agent: 'zara',
    });

    expect(result).toMatchObject({ mode: 'dry-run', agent: 'zara' });
    expect(fetchMock).toHaveBeenCalledWith(
      new URL('http://127.0.0.1:4318/v1/commands/plan'),
      expect.objectContaining({ method: 'POST' }),
    );
  });
});
