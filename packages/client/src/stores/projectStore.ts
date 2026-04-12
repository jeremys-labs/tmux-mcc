import { create } from 'zustand';

export interface Project {
  id: string;
  name: string;
  status: 'active' | 'ready' | 'shipped' | 'paused' | 'concept';
  owner: string;
  ownerName: string;
  emoji: string;
  summary: string;
  blocker?: string;
  nextStep?: string;
  lastUpdated: string;
  docsPath?: string;
}

interface ProjectState {
  projects: Project[];
  loading: boolean;
  error: string | null;
  fetchProjects: () => Promise<void>;
}

export const useProjectStore = create<ProjectState>((set) => ({
  projects: [],
  loading: false,
  error: null,
  fetchProjects: async () => {
    set({ loading: true, error: null });
    try {
      const res = await fetch('/api/projects');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      set({ projects: data, loading: false });
    } catch (err) {
      set({ error: String(err), loading: false });
    }
  },
}));
