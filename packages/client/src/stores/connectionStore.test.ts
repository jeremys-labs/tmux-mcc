import { describe, it, expect, beforeEach } from 'vitest';
import { useConnectionStore } from './connectionStore';

describe('connectionStore', () => {
  beforeEach(() => {
    useConnectionStore.setState({ gatewayStatus: 'connected' });
  });

  it('has a default status of connected', () => {
    expect(useConnectionStore.getState().gatewayStatus).toBe('connected');
  });

  it('setGatewayStatus updates to disconnected', () => {
    useConnectionStore.getState().setGatewayStatus('disconnected');
    expect(useConnectionStore.getState().gatewayStatus).toBe('disconnected');
  });

  it('setGatewayStatus updates to reconnecting', () => {
    useConnectionStore.getState().setGatewayStatus('reconnecting');
    expect(useConnectionStore.getState().gatewayStatus).toBe('reconnecting');
  });

  it('setGatewayStatus can transition back to connected', () => {
    useConnectionStore.getState().setGatewayStatus('disconnected');
    useConnectionStore.getState().setGatewayStatus('connected');
    expect(useConnectionStore.getState().gatewayStatus).toBe('connected');
  });
});
