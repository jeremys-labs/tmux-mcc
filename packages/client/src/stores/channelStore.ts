import { create } from 'zustand';

interface ChannelMessage {
  from: string;
  to: string;
  content: string;
  type?: string;
  timestamp: number;
}

interface ChannelState {
  interactions: ChannelMessage[];
  loading: boolean;
  fetch: () => Promise<void>;
}

export const useChannelStore = create<ChannelState>((set) => ({
  interactions: [],
  loading: true,
  fetch: async () => {
    try {
      const res = await fetch('/api/channels');
      const data = await res.json();
      // Normalize: real data uses `recent` array with `topic` field
      const raw = data.interactions || data.recent || [];
      const interactions = raw.map((m: Record<string, unknown>) => ({
        from: m.from as string,
        to: m.to as string,
        content: (m.content || m.topic || '') as string,
        type: m.type as string | undefined,
        timestamp: typeof m.timestamp === 'string' ? new Date(m.timestamp as string).getTime() : m.timestamp as number,
      }));
      set({ interactions, loading: false });
    } catch {
      set({ loading: false });
    }
  },
}));
