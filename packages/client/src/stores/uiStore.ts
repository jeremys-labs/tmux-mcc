import { create } from 'zustand';

type View = 'office' | 'channels' | 'files' | 'projects';

interface UIState {
  activeView: View;
  activeAgent: string | null;
  panelOpen: boolean;
  panelExpanded: boolean;
  setView: (view: View) => void;
  openAgentPanel: (agentKey: string) => void;
  closePanel: () => void;
  togglePanelExpanded: () => void;
}

export const useUIStore = create<UIState>((set) => ({
  activeView: 'office',
  activeAgent: null,
  panelOpen: false,
  panelExpanded: false,
  setView: (view) => set({ activeView: view }),
  openAgentPanel: (agentKey) => set({ activeAgent: agentKey, panelOpen: true }),
  closePanel: () => set({ panelOpen: false }),
  togglePanelExpanded: () => set((s) => ({ panelExpanded: !s.panelExpanded })),
}));

// Expose for debugging
if (import.meta.env.DEV && typeof window !== 'undefined') {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).__uiStore = useUIStore;
}
