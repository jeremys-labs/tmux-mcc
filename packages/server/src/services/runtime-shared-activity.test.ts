import { describe, expect, it, vi } from 'vitest';
import { createSharedActivitySink } from './runtime-shared-activity.js';
import type { RuntimeEvent } from './runtime-events.js';

function event(overrides: Partial<RuntimeEvent>): RuntimeEvent {
  return {
    name: 'afterAgentTurn',
    agent: 'enzo',
    runtime: 'claude',
    source: 'agent_mail',
    ts: '2026-05-23T00:00:00.000Z',
    ...overrides,
  } as RuntimeEvent;
}

describe('createSharedActivitySink', () => {
  it('appends afterAgentTurn events to activity.jsonl', () => {
    const append = vi.fn();
    const sink = createSharedActivitySink({ sharedDir: '/shared', appendFileSync: append });

    sink(event({
      name: 'afterAgentTurn',
      metadata: { sessionId: 'sess-1', delivery: 'acknowledged' },
    }));

    expect(append).toHaveBeenCalledTimes(1);
    expect(append.mock.calls[0][0]).toBe('/shared/activity.jsonl');
    const row = JSON.parse((append.mock.calls[0][1] as string).trim());
    expect(row).toEqual({
      timestamp: '2026-05-23T00:00:00.000Z',
      agent: 'enzo',
      session_id: 'sess-1',
    });
  });

  it('appends onRuntimeHealth(status=stopped) to status.jsonl with reason', () => {
    const append = vi.fn();
    const sink = createSharedActivitySink({ sharedDir: '/shared', appendFileSync: append });

    sink(event({
      name: 'onRuntimeHealth',
      source: 'runtime',
      metadata: { status: 'stopped', reason: 'sigterm', transcript: '/tmp/t.jsonl' },
    }));

    expect(append).toHaveBeenCalledTimes(1);
    expect(append.mock.calls[0][0]).toBe('/shared/status.jsonl');
    const row = JSON.parse((append.mock.calls[0][1] as string).trim());
    expect(row).toEqual({
      timestamp: '2026-05-23T00:00:00.000Z',
      agent: 'enzo',
      session_id: '',
      reason: 'sigterm',
      transcript: '/tmp/t.jsonl',
    });
  });

  it('ignores onRuntimeHealth events that are not the stopped status', () => {
    const append = vi.fn();
    const sink = createSharedActivitySink({ sharedDir: '/shared', appendFileSync: append });

    sink(event({
      name: 'onRuntimeHealth',
      source: 'runtime',
      metadata: { status: 'started' },
    }));

    expect(append).not.toHaveBeenCalled();
  });

  it('ignores unrelated event names', () => {
    const append = vi.fn();
    const sink = createSharedActivitySink({ sharedDir: '/shared', appendFileSync: append });

    sink(event({ name: 'beforeAgentTurn' }));
    sink(event({ name: 'onInboundMessage' }));

    expect(append).not.toHaveBeenCalled();
  });
});
