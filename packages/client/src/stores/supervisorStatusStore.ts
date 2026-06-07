import { create } from 'zustand';

export interface SupervisorAgentStatus {
  agent: string;
  runtime: string;
  process: { status: string; pid: number };
  progress: {
    status: string;
    detail: string;
    activeSince?: string;
    activeMessageId?: string;
  };
}

interface SupervisorStatusState {
  agents: Record<string, SupervisorAgentStatus>;
  available: boolean;
  setStatus: (agents: SupervisorAgentStatus[]) => void;
  setUnavailable: () => void;
}

export const useSupervisorStatusStore = create<SupervisorStatusState>((set) => ({
  agents: {},
  available: false,
  setStatus: (agents) => set({
    agents: Object.fromEntries(agents.map((agent) => [agent.agent, agent])),
    available: true,
  }),
  setUnavailable: () => set({ available: false }),
}));
