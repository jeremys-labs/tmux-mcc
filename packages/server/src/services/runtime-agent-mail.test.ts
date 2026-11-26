import { describe, expect, it, vi } from 'vitest';
import type { AgentMailMessage } from '@agent-comms/mailbox';
import {
  deliverRuntimeAgentMail,
  enqueuePendingRuntimeAgentMail,
  enqueueRuntimeAgentMailMessages,
  isRestartRecoveryAgentMail,
  listRestartRecoveryAgentMail,
} from './runtime-agent-mail.js';
import { createRuntimeEventEmitter } from './runtime-events.js';
import { createRuntimeTaskQueue } from './runtime-task-queue.js';
import { createBoundedIdSet } from './runtime-delivered-ids.js';

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

  it('acknowledges self-addressed mail without waking the sender', () => {
    const queued: Array<() => Promise<void>> = [];
    const mailStore = {
      listInbox: vi.fn(() => [message({ fromAgent: 'enzo', toAgent: 'enzo' })]),
      ackMessage: vi.fn(),
    };

    enqueuePendingRuntimeAgentMail({
      agentKey: 'enzo',
      mailStore,
      deliveredIds: new Set<string>(),
      events: createRuntimeEventEmitter({ agent: 'enzo', runtime: 'codex', sinks: [] }),
      submitPrompt: async () => undefined,
      runtimeLogPath: '/tmp/enzo.log',
      enqueue: (task) => queued.push(task),
    });

    expect(queued).toHaveLength(0);
    expect(mailStore.ackMessage).toHaveBeenCalledWith('enzo', 'msg_1');
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

  it('releases a hung delivery from deliveredIds on queue timeout so the next poll retries it', async () => {
    const deliveredIds = createBoundedIdSet(100);
    const queue = createRuntimeTaskQueue({ defaultTimeoutMs: 30 });
    const mailStore = {
      listInbox: vi.fn(() => [message()]),
      ackMessage: vi.fn(),
    };
    const baseArgs = {
      agentKey: 'enzo',
      mailStore,
      deliveredIds,
      events: createRuntimeEventEmitter({ agent: 'enzo', runtime: 'codex', sinks: [] }),
      runtimeLogPath: '/tmp/enzo.log',
    };

    // First poll: delivery hangs forever (busy pane never returns from submit).
    enqueuePendingRuntimeAgentMail({
      ...baseArgs,
      submitPrompt: () => new Promise<void>(() => { /* never resolves */ }),
      enqueue: queue.enqueue,
    });
    expect(deliveredIds.has('msg_1')).toBe(true);

    await queue.idle();

    // Queue timeout abandons the task; the id must be released, not left stuck-and-skipped.
    expect(deliveredIds.has('msg_1')).toBe(false);
    expect(mailStore.ackMessage).not.toHaveBeenCalled();

    // Next poll re-enqueues the same message because it is no longer deduped.
    const queued: Array<() => Promise<void>> = [];
    enqueuePendingRuntimeAgentMail({
      ...baseArgs,
      submitPrompt: async () => undefined,
      enqueue: (task) => queued.push(task),
    });
    expect(queued).toHaveLength(1);
    expect(deliveredIds.has('msg_1')).toBe(true);
  }, 1000);

  it('bounds restart recovery by age and count, newest first, and excludes non-obligations', () => {
    const nowMs = Date.parse('2026-11-25T18:00:00.000Z');
    const recent = Array.from({ length: 12 }, (_, index) => message({
      id: `msg_recent_${index}`,
      requiresResponse: true,
      status: 'acked',
      ackedAt: new Date(nowMs - index * 1_000).toISOString(),
    }));
    const informational = message({
      id: 'msg_informational',
      requiresResponse: false,
      status: 'acked',
      ackedAt: new Date(nowMs - 500).toISOString(),
    });
    const stale = message({
      id: 'msg_stale',
      requiresResponse: true,
      status: 'acked',
      ackedAt: new Date(nowMs - 25 * 60 * 60 * 1_000).toISOString(),
    });
    const mailStore = {
      listInbox: vi.fn(() => [...recent].reverse().concat(informational, stale)),
      listEvents: vi.fn(() => []),
    };

    const recovered = listRestartRecoveryAgentMail(mailStore, 'enzo', {
      nowMs,
      maxAgeMs: 24 * 60 * 60 * 1_000,
      limit: 10,
    });

    expect(recovered.map((item) => item.id)).toEqual(
      Array.from({ length: 10 }, (_, index) => `msg_recent_${index}`),
    );
    expect(recovered.map((item) => item.id)).not.toContain('msg_informational');
    expect(recovered.map((item) => item.id)).not.toContain('msg_stale');
    expect(listRestartRecoveryAgentMail({
      listInbox: vi.fn(() => [stale]),
      listEvents: vi.fn(() => []),
    }, 'enzo', {
      nowMs,
      maxAgeMs: 24 * 60 * 60 * 1_000,
      limit: 10,
    })).toEqual([]);
  });

  it('revalidates one recovery id without rescanning the ACKED inbox', () => {
    const eligible = message({
      requiresResponse: true,
      status: 'acked',
      ackedAt: '2026-11-25T17:59:00.000Z',
    });
    const mailStore = {
      getMessage: vi.fn(() => eligible),
      listEvents: vi.fn(() => []),
    };

    expect(isRestartRecoveryAgentMail(mailStore, 'enzo', eligible.id, {
      nowMs: Date.parse('2026-11-25T18:00:00.000Z'),
      maxAgeMs: 24 * 60 * 60 * 1_000,
    })).toBe(true);
    expect(mailStore.getMessage).toHaveBeenCalledWith(eligible.id);
    expect(mailStore.listEvents).toHaveBeenCalledWith(eligible.id);
  });

  it.each([
    ['another recipient', { toAgent: 'someone-else' }],
    ['a future acknowledgement', { ackedAt: '2026-11-25T18:01:00.000Z' }],
  ])('rejects recovery by id for %s', (_description, overrides) => {
    const candidate = message({
      requiresResponse: true,
      status: 'acked',
      ackedAt: '2026-11-25T17:59:00.000Z',
      ...overrides,
    });
    const mailStore = {
      getMessage: vi.fn(() => candidate),
      listEvents: vi.fn(() => []),
    };

    expect(isRestartRecoveryAgentMail(mailStore, 'enzo', candidate.id, {
      nowMs: Date.parse('2026-11-25T18:00:00.000Z'),
    })).toBe(false);
  });

  it('settles recovered work after submit succeeds even if acknowledgement throws', async () => {
    const queued: Array<() => Promise<void>> = [];
    const deliveredIds = createBoundedIdSet(100);
    const onDelivered = vi.fn();
    const recovered = message({
      requiresResponse: true,
      status: 'acked',
      ackedAt: '2026-11-25T17:59:00.000Z',
    });

    enqueueRuntimeAgentMailMessages({
      agentKey: 'enzo',
      mailStore: { ackMessage: vi.fn(() => { throw new Error('post-submit ack failed'); }) },
      messages: [recovered],
      deliveredIds,
      events: createRuntimeEventEmitter({ agent: 'enzo', runtime: 'codex', sinks: [] }),
      submitPrompt: async () => undefined,
      runtimeLogPath: '/tmp/enzo.log',
      enqueue: (task) => queued.push(task),
      settleAfterSubmitError: true,
      onDelivered,
    });

    await queued[0]();
    expect(onDelivered).toHaveBeenCalledWith(recovered);
    expect(deliveredIds.has(recovered.id)).toBe(true);
  });

  it('retains a recovered id on timeout so a detached submit cannot race a retry', () => {
    const queued: Array<() => Promise<void>> = [];
    const options: Array<{ onTimeout?: () => void }> = [];
    const deliveredIds = createBoundedIdSet(100);
    const recovered = message({
      requiresResponse: true,
      status: 'acked',
      ackedAt: '2026-11-25T17:59:00.000Z',
    });
    const base = {
      agentKey: 'enzo',
      mailStore: { ackMessage: vi.fn() },
      messages: [recovered],
      deliveredIds,
      events: createRuntimeEventEmitter({ agent: 'enzo', runtime: 'codex', sinks: [] }),
      submitPrompt: () => new Promise<void>(() => { /* detached task remains pending */ }),
      runtimeLogPath: '/tmp/enzo.log',
      enqueue: (task: () => Promise<void>, opts?: { onTimeout?: () => void }) => {
        queued.push(task);
        options.push(opts ?? {});
      },
      releaseOnTimeout: false,
    };

    enqueueRuntimeAgentMailMessages(base);
    expect(queued).toHaveLength(1);
    options[0].onTimeout?.();
    expect(deliveredIds.has(recovered.id)).toBe(true);

    enqueueRuntimeAgentMailMessages(base);
    expect(queued).toHaveLength(1);
  });
});
