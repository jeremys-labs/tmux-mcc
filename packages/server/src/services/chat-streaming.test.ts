import { describe, it, expect, vi } from 'vitest';
import { ChatStreamService } from './chat-streaming.js';

describe('ChatStreamService', () => {
  function createMockRes() {
    const written: string[] = [];
    return {
      writeHead: vi.fn(),
      write: vi.fn((data: string) => { written.push(data); return true; }),
      on: vi.fn(),
      end: vi.fn(),
      _written: written,
    } as unknown as import('express').Response & { _written: string[] };
  }

  it('tracks subscribers per agent (starts at 0)', () => {
    const service = new ChatStreamService();
    expect(service.getSubscriberCount('alice')).toBe(0);
  });

  it('increments subscriber count on subscribe', () => {
    const service = new ChatStreamService();
    const res = createMockRes();
    service.subscribe('alice', res);
    expect(service.getSubscriberCount('alice')).toBe(1);
  });

  it('sets SSE headers on subscribe', () => {
    const service = new ChatStreamService();
    const res = createMockRes();
    service.subscribe('alice', res);
    expect(res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({
      'Content-Type': 'text/event-stream',
    }));
  });

  it('sends connected event on subscribe', () => {
    const service = new ChatStreamService();
    const res = createMockRes();
    service.subscribe('alice', res);
    expect(res._written.some(w => w.includes('event: connected'))).toBe(true);
  });

  it('emits message.delta events to listeners', () => {
    const service = new ChatStreamService();
    const res = createMockRes();
    service.subscribe('alice', res);

    const listener = vi.fn();
    service.on('message.delta', listener);

    service.broadcastDelta('alice', 'msg-1', 'Hello');
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({
      agent: 'alice',
      messageId: 'msg-1',
      content: 'Hello',
    }));
    expect(res._written.some(w => w.includes('event: message.delta'))).toBe(true);
  });

  it('emits final events with complete:true', () => {
    const service = new ChatStreamService();
    const res = createMockRes();
    service.subscribe('alice', res);

    const listener = vi.fn();
    service.on('message.final', listener);

    service.broadcastFinal('alice', 'msg-1', 'Full response', 5);
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({
      agent: 'alice',
      messageId: 'msg-1',
      content: 'Full response',
      complete: true,
      seq: 5,
    }));
  });

  it('emits abort events', () => {
    const service = new ChatStreamService();
    const res = createMockRes();
    service.subscribe('alice', res);

    const listener = vi.fn();
    service.on('message.aborted', listener);

    service.broadcastAbort('alice', 'msg-1', 'User cancelled');
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({
      agent: 'alice',
      messageId: 'msg-1',
      reason: 'User cancelled',
    }));
  });

  it('emits error events', () => {
    const service = new ChatStreamService();
    const res = createMockRes();
    service.subscribe('alice', res);

    const listener = vi.fn();
    service.on('message.error', listener);

    service.broadcastError('alice', 'msg-1', 'Something failed');
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({
      agent: 'alice',
      messageId: 'msg-1',
      error: 'Something failed',
    }));
  });

  it('broadcasts context update with percentUsed', () => {
    const service = new ChatStreamService();
    const res = createMockRes();
    service.subscribe('alice', res);

    const listener = vi.fn();
    service.on('context.update', listener);

    service.broadcastContextUpdate('alice', 5000, 10000);
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({
      agent: 'alice',
      tokens: 5000,
      maxTokens: 10000,
      percentUsed: 50,
    }));
  });
});
