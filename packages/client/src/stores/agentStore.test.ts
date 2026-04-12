import { describe, expect, it, beforeEach } from 'vitest';
import { useAgentStore } from './agentStore';

describe('agentStore provider updates', () => {
  beforeEach(() => {
    useAgentStore.setState({
      agents: {},
      loading: false,
      error: null,
    });
  });

  it('updates one agent provider without replacing the full map', () => {
    useAgentStore.setState({
      agents: {
        zara: {
          name: 'Zara',
          role: 'Engineer',
          emoji: '🛠️',
          color: { from: '#111', to: '#222' },
          channel: 'test',
          greeting: 'hi',
          position: { zone: 'desk', x: 0, y: 0 },
          tabs: [],
          providerType: 'llm',
        },
        marcus: {
          name: 'Marcus',
          role: 'CTO',
          emoji: '🏗️',
          color: { from: '#333', to: '#444' },
          channel: 'test',
          greeting: 'hi',
          position: { zone: 'desk', x: 1, y: 0 },
          tabs: [],
          providerType: 'llm',
        },
      },
      loading: false,
      error: null,
    });

    useAgentStore.getState().updateAgentProvider('zara', 'persistent-harness', {
      adapter: 'claude-code',
      cwd: '/Volumes/Repo-Drive/src/openclaw-mcc',
    });

    const state = useAgentStore.getState();
    expect(state.agents.zara.providerType).toBe('persistent-harness');
    expect(state.agents.zara.harnessConfig?.adapter).toBe('claude-code');
    expect(state.agents.marcus.providerType).toBe('llm');
  });
});
