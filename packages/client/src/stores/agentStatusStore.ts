import { create } from 'zustand';

export type AgentStatus = 'idle' | 'thinking' | 'awaiting_input';

interface AgentStatusState {
  statuses: Record<string, AgentStatus>;
  setStatus: (agentKey: string, status: AgentStatus) => void;
}

export const useAgentStatusStore = create<AgentStatusState>((set) => ({
  statuses: {},
  setStatus: (agentKey, status) =>
    set((s) => ({ statuses: { ...s.statuses, [agentKey]: status } })),
}));
