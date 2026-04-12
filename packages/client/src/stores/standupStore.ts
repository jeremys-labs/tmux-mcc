import { create } from 'zustand';

interface AgentStandup {
  status: 'completed' | 'pending' | 'blocked';
  yesterday?: string;
  today?: string;
  blockers?: string;
  learned?: string;
  completedAt?: string;
}

interface StandupState {
  date: string | null;
  agents: Record<string, AgentStandup>;
  loading: boolean;
  fetch: () => Promise<void>;
}

export const useStandupStore = create<StandupState>((set) => ({
  date: null,
  agents: {},
  loading: true,
  fetch: async () => {
    try {
      const res = await fetch('/api/standup');
      const data = await res.json();
      set({ date: data.date, agents: data.agents || {}, loading: false });
    } catch {
      set({ loading: false });
    }
  },
}));
