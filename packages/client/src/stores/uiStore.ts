import { create } from 'zustand';

type View = 'office' | 'channels' | 'projects';

interface UIState {
  activeView: View | null;   // null = show terminal for activeAgent
  activeAgent: string | null;
  fileSplitOpen: boolean;
  mobileInfoOpen: boolean;
  setView: (view: View) => void;
  setActiveAgent: (agentKey: string) => void;
  toggleFileSplit: () => void;
  setMobileInfoOpen: (open: boolean) => void;
}

export const useUIStore = create<UIState>((set) => ({
  activeView: null,
  activeAgent: null,
  fileSplitOpen: false,
  mobileInfoOpen: false,
  setView: (view) => set({ activeView: view }),
  setActiveAgent: (agentKey) => set({ activeAgent: agentKey, activeView: null, mobileInfoOpen: false }),
  toggleFileSplit: () => set((s) => ({ fileSplitOpen: !s.fileSplitOpen })),
  setMobileInfoOpen: (open) => set({ mobileInfoOpen: open }),
}));

// Expose for debugging
if (import.meta.env.DEV && typeof window !== 'undefined') {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).__uiStore = useUIStore;
}
