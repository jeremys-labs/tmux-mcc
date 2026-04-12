import { create } from 'zustand';

interface VoiceState {
  activeAgent: string | null;
  isRecording: boolean;
  isPlaying: boolean;
  isTranscribing: boolean;
  voiceAvailable: boolean;
  error: string | null;

  setActiveAgent: (agent: string | null) => void;
  setRecording: (recording: boolean) => void;
  setPlaying: (playing: boolean) => void;
  setTranscribing: (transcribing: boolean) => void;
  setVoiceAvailable: (available: boolean) => void;
  setError: (error: string | null) => void;
}

export const useVoiceStore = create<VoiceState>((set) => ({
  activeAgent: null,
  isRecording: false,
  isPlaying: false,
  isTranscribing: false,
  voiceAvailable: false,
  error: null,

  setActiveAgent: (agent) => set({ activeAgent: agent }),
  setRecording: (recording) => set({ isRecording: recording }),
  setPlaying: (playing) => set({ isPlaying: playing }),
  setTranscribing: (transcribing) => set({ isTranscribing: transcribing }),
  setVoiceAvailable: (available) => set({ voiceAvailable: available }),
  setError: (error) => set({ error }),
}));
