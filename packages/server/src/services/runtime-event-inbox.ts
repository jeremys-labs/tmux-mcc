import fs from 'fs';
import {
  formatEventInboxForRuntime,
  type EventInboxRecord,
  type EventInboxStore,
} from '@agent-comms/event-inbox';
import {
  runInboundRuntimeTurn,
  type RuntimeEventEmitter,
} from './runtime-events.js';
import type { DeliveredIdSet } from './runtime-delivered-ids.js';

export interface RuntimeEventInboxDeliveryInput {
  agentKey: string;
  event: EventInboxRecord;
  eventInbox: Pick<EventInboxStore, 'ackEvent'>;
  events: RuntimeEventEmitter;
  submitPrompt: (prompt: string, event: EventInboxRecord) => Promise<void>;
  runtimeLogPath: string;
}

export interface EnqueuePendingRuntimeEventInboxInput extends Omit<RuntimeEventInboxDeliveryInput, 'event'> {
  eventInbox: Pick<EventInboxStore, 'ackEvent' | 'listInbox'>;
  deliveredIds: DeliveredIdSet;
  enqueue: (task: () => Promise<void>) => void;
}

function appendRuntimeLog(runtimeLogPath: string, line: string): void {
  fs.appendFileSync(runtimeLogPath, `${new Date().toISOString()} ${line}\n`);
}

export async function deliverRuntimeEventInbox(input: RuntimeEventInboxDeliveryInput): Promise<void> {
  const { agentKey, event, eventInbox, events, submitPrompt, runtimeLogPath } = input;

  await runInboundRuntimeTurn({
    emit: events.emit,
    source: 'event_inbox',
    messageId: String(event.id),
    preparePrompt: async () => formatEventInboxForRuntime(event),
    submitPrompt: (prompt) => submitPrompt(prompt, event),
    acknowledgeDelivery: () => {
      eventInbox.ackEvent(agentKey, event.id);
      appendRuntimeLog(runtimeLogPath, `acknowledged event-inbox ${event.id}`);
    },
  });
}

export function enqueuePendingRuntimeEventInbox(input: EnqueuePendingRuntimeEventInboxInput): void {
  const pendingEvents = input.eventInbox.listInbox({ agent: input.agentKey, status: 'new' });
  for (const event of pendingEvents) {
    const eventId = String(event.id);
    if (input.deliveredIds.has(eventId)) continue;
    input.deliveredIds.add(eventId);
    input.enqueue(async () => {
      try {
        await deliverRuntimeEventInbox({ ...input, event });
        input.deliveredIds.settle?.(eventId);
      } catch (error) {
        input.deliveredIds.delete(eventId);
        appendRuntimeLog(input.runtimeLogPath, `event-inbox inject error ${event.id}: ${String(error)}`);
      }
    });
  }
}
