import { describe, expect, it, vi } from 'vitest';
import type { AgentMailMessage } from '@agent-comms/mailbox';
import {
  deliverRuntimeAgentMail,
  enqueuePendingRuntimeAgentMail,
} from './runtime-agent-mail.js';
import { createRuntimeEventEmitter } from './runtime-events.js';

vi.mock('fs', () => ({
  default: {
    appendFileSync: vi.fn(),
  },
}));

vi.mock('./answer-context.js', () => ({
  buildAnswerContext: vi.fn(async () => '[Answer Context]\nKnown context.'),
}));

vi.mock('./open-brain-runtime.js', () => ({
  captureAgentMailMessage: vi.fn(),
}));

function message(overrides: Partial<AgentMailMessage> = {}): AgentMailMessage {
  return {
    id: 'msg_1',
    correlationId: 'corr_1',
    fromAgent: 'marcus',
    toAgent: 'enzo',
    type: 'handoff',
    priority: 'normal',
    subject: 'Runtime handoff',
    bodyMd: 'Please review this.',
    relatedProject: null,
    requiresResponse: false,
    status: 'new',
    createdAt: '2026-05-12T22:00:00.000Z',
    ackedAt: null,
    closedAt: null,
    ...overrides,
  };
}

describe('runtime agent-mail delivery', () => {
  it('builds context, submits the prompt, then acknowledges the message', async () => {
    const order: string[] = [];
    const events = createRuntimeEventEmitter({
      agent: 'enzo',
      runtime: 'codex',
      sinks: [(event) => order.push(event.name)],
    });
    const mailStore = {
      ackMessage: vi.fn(() => {
        order.push('ack');
        return message({ status: 'acked' });
      }),
    };
    const submitPrompt = vi.fn(async (prompt: string) => {
      order.push('submit');
      expect(prompt).toContain('[Answer Context]');
      expect(prompt).toContain('[Agent Mail] New message from marcus');
    });

    await deliverRuntimeAgentMail({
      agentKey: 'enzo',
      message: message(),
      mailStore,
      events,
      submitPrompt,
      runtimeLogPath: '/tmp/enzo.log',
    });

    expect(order).toEqual(['onInboundMessage', 'beforeAgentTurn', 'submit', 'ack', 'afterAgentTurn']);
    expect(mailStore.ackMessage).toHaveBeenCalledWith('enzo', 'msg_1');
  });

  it('does not acknowledge when prompt submission fails', async () => {
    const events = createRuntimeEventEmitter({ agent: 'enzo', runtime: 'codex', sinks: [] });
    const mailStore = { ackMessage: vi.fn() };

    await expect(
      deliverRuntimeAgentMail({
        agentKey: 'enzo',
        message: message(),
        mailStore,
        events,
        submitPrompt: async () => {
          throw new Error('submit failed');
        },
        runtimeLogPath: '/tmp/enzo.log',
      })
    ).rejects.toThrow('submit failed');

    expect(mailStore.ackMessage).not.toHaveBeenCalled();
  });

  it('dedupes queued pending mail and releases the id on delivery failure', async () => {
    const deliveredIds = new Set<string>();
    const queued: Array<() => Promise<void>> = [];
    const mailStore = {
      listInbox: vi.fn(() => [message()]),
      ackMessage: vi.fn(),
    };

    enqueuePendingRuntimeAgentMail({
      agentKey: 'enzo',
      mailStore,
      deliveredIds,
      events: createRuntimeEventEmitter({ agent: 'enzo', runtime: 'codex', sinks: [] }),
      submitPrompt: async () => {
        throw new Error('runtime unavailable');
      },
      runtimeLogPath: '/tmp/enzo.log',
      enqueue: (task) => queued.push(task),
    });
    enqueuePendingRuntimeAgentMail({
      agentKey: 'enzo',
      mailStore,
      deliveredIds,
      events: createRuntimeEventEmitter({ agent: 'enzo', runtime: 'codex', sinks: [] }),
      submitPrompt: async () => undefined,
      runtimeLogPath: '/tmp/enzo.log',
      enqueue: (task) => queued.push(task),
    });

    expect(queued).toHaveLength(1);
    expect(deliveredIds.has('msg_1')).toBe(true);

    await queued[0]();

    expect(deliveredIds.has('msg_1')).toBe(false);
  });
});
