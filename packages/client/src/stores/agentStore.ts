import { create } from 'zustand';
import type { AgentConfig } from '../types/agent';

interface AgentState {
  agents: Record<string, AgentConfig>;
  loading: boolean;
  error: string | null;
  setAgents: (agents: Record<string, AgentConfig>) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  updateAgentProvider: (
    agentKey: string,
    providerType: 'llm' | 'persistent-harness',
    harnessConfig?: AgentConfig['harnessConfig']
  ) => void;
}

export const useAgentStore = create<AgentState>((set) => ({
  agents: {},
  loading: true,
  error: null,
  setAgents: (agents) => set({ agents, loading: false }),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error, loading: false }),
  updateAgentProvider: (agentKey, providerType, harnessConfig) => set((state) => ({
    agents: {
      ...state.agents,
      [agentKey]: {
        ...state.agents[agentKey],
        providerType,
        harnessConfig: providerType === 'llm' ? undefined : harnessConfig,
      },
    },
  })),
}));
