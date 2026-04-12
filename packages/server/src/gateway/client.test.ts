import { describe, it, expect } from 'vitest';
import { GatewayClient } from './client.js';

describe('GatewayClient', () => {
  it('can instantiate with url and token', () => {
    const client = new GatewayClient('ws://localhost:18789', 'test-token');
    expect(client).toBeInstanceOf(GatewayClient);
  });

  it('isConnected starts false', () => {
    const client = new GatewayClient('ws://localhost:18789', 'test-token');
    expect(client.isConnected).toBe(false);
  });

  it('buildConnectPayload returns correct structure', () => {
    const client = new GatewayClient('ws://localhost:18789', 'my-secret');
    const payload = client.buildConnectPayload();

    expect(payload.type).toBe('req');
    expect(payload.method).toBe('connect');
    expect(payload.id).toBeTypeOf('string');
    const params = payload.params as Record<string, unknown>;
    expect(params.role).toBe('operator');
    expect(params.scopes).toEqual(['operator.read', 'operator.write', 'operator.admin']);
    expect(params.auth).toEqual({ token: 'my-secret' });
    expect(params.minProtocol).toBe(3);
    expect(params.maxProtocol).toBe(3);
  });

  it('nextId increments', () => {
    const client = new GatewayClient('ws://localhost:18789', 'test-token');
    const id1 = client.nextId();
    const id2 = client.nextId();
    const id3 = client.nextId();

    expect(Number(id2)).toBe(Number(id1) + 1);
    expect(Number(id3)).toBe(Number(id2) + 1);
  });
});
