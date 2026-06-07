import { beforeEach, describe, expect, it } from 'vitest';
import { useSupervisorStatusStore } from './supervisorStatusStore';

describe('supervisor status store', () => {
  beforeEach(() => useSupervisorStatusStore.setState({ agents: {}, available: false }));

  it('indexes supervisor-owned status by agent', () => {
    useSupervisorStatusStore.getState().setStatus([{
      agent: 'zara',
      runtime: 'claude',
      process: { status: 'running', pid: 1 },
      progress: { status: 'idle', detail: 'last turn completed' },
    }]);

    expect(useSupervisorStatusStore.getState()).toMatchObject({
      available: true,
      agents: { zara: { process: { status: 'running' } } },
    });
  });
});
