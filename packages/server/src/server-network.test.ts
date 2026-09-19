import { describe, expect, it } from 'vitest';
import { resolveServerHost } from './server-network.js';

describe('resolveServerHost', () => {
  it('binds to loopback by default', () => {
    expect(resolveServerHost(undefined)).toBe('127.0.0.1');
    expect(resolveServerHost('')).toBe('127.0.0.1');
  });

  it('allows an explicit deployment host', () => {
    expect(resolveServerHost('0.0.0.0')).toBe('0.0.0.0');
  });
});
