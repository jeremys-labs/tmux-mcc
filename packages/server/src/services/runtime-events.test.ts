import { describe, expect, it, vi } from 'vitest';
import {
  createRuntimeEventEmitter,
  emitRuntimeEvent,
  runInboundRuntimeTurn,
  type RuntimeEvent,
} from './runtime-events.js';

describe('runtime events', () => {
  it('emits inbound turn events in lifecycle order', async () => {
    const seen: string[] = [];
    const emitter = createRuntimeEventEmitter({
      agent: 'enzo',
      runtime: 'codex',
      now: () => new Date('2026-05-12T22:00:00.000Z'),
      sinks: [(event) => seen.push(`${event.name}:${event.messageId}:${event.source}`)],
    });

    await runInboundRuntimeTurn({
      emit: emitter.emit,
      source: 'discord',
      messageId: 'discord-1',
      preparePrompt: async () => 'hello enzo',
      submitPrompt: async () => undefined,
      acknowledgeDelivery: async () => undefined,
    });

    expect(seen).toEqual([
      'onInboundMessage:discord-1:discord',
      'beforeAgentTurn:discord-1:discord',
      'afterAgentTurn:discord-1:discord',
    ]);
  });

  it('does not emit afterAgentTurn when delivery acknowledgement fails', async () => {
    const seen: RuntimeEvent[] = [];
    const emitter = createRuntimeEventEmitter({
      agent: 'enzo',
      runtime: 'codex',
      sinks: [(event) => seen.push(event)],
    });

    await expect(
      runInboundRuntimeTurn({
        emit: emitter.emit,
        source: 'agent_mail',
        messageId: 'msg_123',
        preparePrompt: async () => 'mail prompt',
        submitPrompt: async () => undefined,
        acknowledgeDelivery: async () => {
          throw new Error('ack failed');
        },
      })
    ).rejects.toThrow('ack failed');

    expect(seen.map((event) => event.name)).toEqual(['onInboundMessage', 'beforeAgentTurn']);
  });

  it('keeps runtime execution moving when one event sink fails', async () => {
    const goodSink = vi.fn();
    const onError = vi.fn();
    const event: RuntimeEvent = {
      name: 'onRuntimeHealth',
      agent: 'enzo',
      runtime: 'claude',
      source: 'runtime',
      ts: '2026-05-12T22:00:00.000Z',
    };

    await emitRuntimeEvent(
      [
        () => {
          throw new Error('sink unavailable');
        },
        goodSink,
      ],
      event,
      onError
    );

    expect(onError).toHaveBeenCalledOnce();
    expect(goodSink).toHaveBeenCalledWith(event);
  });
});
