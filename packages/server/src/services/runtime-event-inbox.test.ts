import { describe, expect, it, vi } from 'vitest';
import type { EventInboxRecord } from './event-inbox.js';
import {
  deliverRuntimeEventInbox,
  enqueuePendingRuntimeEventInbox,
} from './runtime-event-inbox.js';
import { formatEventInboxForRuntime } from '@agent-comms/event-inbox';
import { createRuntimeEventEmitter } from './runtime-events.js';

vi.mock('fs', () => ({
  default: {
    appendFileSync: vi.fn(),
  },
}));

function event(overrides: Partial<EventInboxRecord> = {}): EventInboxRecord {
  return {
    id: 7,
    source: 'home_assistant',
    sourceEventId: 'ha-1',
    eventType: 'battery_low',
    receivedAt: '2026-06-01T22:00:00.000Z',
    occurredAt: '2026-06-01T22:00:00.000Z',
    ownerAgent: 'hank',
    routeKey: 'home-assistant:battery_low:lock.front_door',
    priority: 'high',
    risk: 'low',
    status: 'new',
    dedupeKey: 'home_assistant:ha-1',
    summary: 'Front door lock battery low',
    payload: { entity_id: 'lock.front_door', state: '18%' },
    attempts: 0,
    lastError: null,
    ackedAt: null,
    closedAt: null,
    outcome: null,
    ...overrides,
  };
}

describe('runtime event-inbox delivery', () => {
  it('formats a compact event prompt with action guardrails for risky events', () => {
    const prompt = formatEventInboxForRuntime(event({ risk: 'medium', summary: 'Front door unlocked at 10pm' }));

    expect(prompt).toContain('[Event Inbox] New home_assistant event for hank.');
    expect(prompt).toContain('summary: Front door unlocked at 10pm');
    expect(prompt).toContain('guardrail: do not take actuation');
    expect(prompt).toContain('"entity_id": "lock.front_door"');
  });

  it('submits the event prompt and acknowledges after successful delivery', async () => {
    const order: string[] = [];
    const events = createRuntimeEventEmitter({
      agent: 'hank',
      runtime: 'codex',
      sinks: [(runtimeEvent) => order.push(runtimeEvent.name)],
    });
    const eventInbox = {
      ackEvent: vi.fn(() => {
        order.push('ack');
        return event({ status: 'acked' });
      }),
    };
    const submitPrompt = vi.fn(async (prompt: string) => {
      order.push('submit');
      expect(prompt).toContain('Front door lock battery low');
    });

    await deliverRuntimeEventInbox({
      agentKey: 'hank',
      event: event(),
      eventInbox,
      events,
      submitPrompt,
      runtimeLogPath: '/tmp/hank.log',
    });

    expect(order).toEqual(['onInboundMessage', 'beforeAgentTurn', 'submit', 'ack', 'afterAgentTurn']);
    expect(eventInbox.ackEvent).toHaveBeenCalledWith('hank', 7);
  });

  it('dedupes queued pending events and releases the id on delivery failure', async () => {
    const deliveredIds = new Set<string>();
    const queued: Array<() => Promise<void>> = [];
    const eventInbox = {
      listInbox: vi.fn(() => [event()]),
      ackEvent: vi.fn(),
    };

    enqueuePendingRuntimeEventInbox({
      agentKey: 'hank',
      eventInbox,
      deliveredIds,
      events: createRuntimeEventEmitter({ agent: 'hank', runtime: 'codex', sinks: [] }),
      submitPrompt: async () => {
        throw new Error('runtime unavailable');
      },
      runtimeLogPath: '/tmp/hank.log',
      enqueue: (task) => queued.push(task),
    });
    enqueuePendingRuntimeEventInbox({
      agentKey: 'hank',
      eventInbox,
      deliveredIds,
      events: createRuntimeEventEmitter({ agent: 'hank', runtime: 'codex', sinks: [] }),
      submitPrompt: async () => undefined,
      runtimeLogPath: '/tmp/hank.log',
      enqueue: (task) => queued.push(task),
    });

    expect(queued).toHaveLength(1);
    expect(deliveredIds.has('7')).toBe(true);

    await queued[0]();

    expect(deliveredIds.has('7')).toBe(false);
  });
});
