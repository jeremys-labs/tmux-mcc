import { create } from 'zustand';

interface ConnectionMetrics {
  latency: number;
  packetLoss: number;
  lastPongTime: number;
}

interface ConnectionState {
  gatewayStatus: 'connected' | 'disconnected' | 'reconnecting';
  metrics: ConnectionMetrics;
  setGatewayStatus: (status: ConnectionState['gatewayStatus']) => void;
  setMetrics: (metrics: Partial<ConnectionMetrics>) => void;
}

export const useConnectionStore = create<ConnectionState>((set) => ({
  gatewayStatus: 'connected',
  metrics: { latency: 0, packetLoss: 0, lastPongTime: 0 },
  setGatewayStatus: (status) => set({ gatewayStatus: status }),
  setMetrics: (metrics) => set((state) => ({ metrics: { ...state.metrics, ...metrics } })),
}));
