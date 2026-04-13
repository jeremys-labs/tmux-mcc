import { create } from 'zustand';

type View = 'office' | 'channels' | 'projects' | 'files';

interface UIState {
  activeView: View | null;   // null = show terminal for active agent (from URL)
  fileSplitOpen: boolean;
  mobileInfoOpen: boolean;
  setView: (view: View) => void;
  clearView: () => void;
  toggleFileSplit: () => void;
  setMobileInfoOpen: (open: boolean) => void;
}

export const useUIStore = create<UIState>((set) => ({
  activeView: null,
  fileSplitOpen: false,
  mobileInfoOpen: false,
  setView: (view) => set({ activeView: view }),
  clearView: () => set({ activeView: null, mobileInfoOpen: false }),
  toggleFileSplit: () => set((s) => ({ fileSplitOpen: !s.fileSplitOpen })),
  setMobileInfoOpen: (open) => set({ mobileInfoOpen: open }),
}));

// Expose for debugging
if (import.meta.env.DEV && typeof window !== 'undefined') {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).__uiStore = useUIStore;
}
