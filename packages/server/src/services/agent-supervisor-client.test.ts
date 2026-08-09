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
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchAgentSupervisorStatus(undefined, { maxAttempts: 3, retryDelayMs: 0 })).rejects.toThrow('fetch failed');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('retries a single transient blip and then succeeds', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({
          mode: 'observe-only',
          agents: [{ agent: 'zara', runtime: 'claude', process: { status: 'running', pid: 1 }, progress: { status: 'idle', detail: 'last turn completed' } }],
        }),
      });
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchAgentSupervisorStatus(undefined, { maxAttempts: 2, retryDelayMs: 0 });

    expect(result.agents[0]).toMatchObject({ agent: 'zara' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry a permanent client error', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => 'not found',
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchAgentSupervisorStatus(undefined, { maxAttempts: 3, retryDelayMs: 0 })).rejects.toThrow('404');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // routes/health.ts calls both of these with no retryOptions, so the shipped
  // defaults are what production actually runs on. Every test above overrides
  // maxAttempts, which leaves the default unpinned: dropping it to 1 keeps them
  // all green. These two fail if the default stops retrying.
  it('retries on the shipped default when the caller passes no options', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({ mode: 'observe-only', agents: [] }),
      });
    vi.stubGlobal('fetch', fetchMock);

    await fetchAgentSupervisorStatus();

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('plans on the shipped default retry too', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce({
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

    await planAgentSupervisorCommand({ requestId: 'req-1', operation: 'restart', agent: 'zara' });

    expect(fetchMock).toHaveBeenCalledTimes(2);
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
