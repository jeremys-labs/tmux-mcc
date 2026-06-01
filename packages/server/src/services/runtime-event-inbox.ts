import fs from 'fs';
import {
  type EventInboxRecord,
  type EventInboxStore,
} from './event-inbox.js';
import {
  runInboundRuntimeTurn,
  type RuntimeEventEmitter,
} from './runtime-events.js';

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
  deliveredIds: Set<number>;
  enqueue: (task: () => Promise<void>) => void;
}

function appendRuntimeLog(runtimeLogPath: string, line: string): void {
  fs.appendFileSync(runtimeLogPath, `${new Date().toISOString()} ${line}\n`);
}

export function formatEventInboxForRuntime(event: EventInboxRecord): string {
  const payload = JSON.stringify(event.payload, null, 2);
  return [
    `[Event Inbox] New ${event.source} event for ${event.ownerAgent}.`,
    '',
    `id: ${event.id}`,
    `type: ${event.eventType}`,
    `route: ${event.routeKey}`,
    `priority: ${event.priority}`,
    `risk: ${event.risk}`,
    `summary: ${event.summary}`,
    event.risk === 'medium' || event.risk === 'high'
      ? 'guardrail: do not take actuation or external-write action unless the event policy explicitly allows it.'
      : null,
    '',
    'payload:',
    payload,
  ].filter(Boolean).join('\n');
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
    if (input.deliveredIds.has(event.id)) continue;
    input.deliveredIds.add(event.id);
    input.enqueue(async () => {
      try {
        await deliverRuntimeEventInbox({ ...input, event });
      } catch (error) {
        input.deliveredIds.delete(event.id);
        appendRuntimeLog(input.runtimeLogPath, `event-inbox inject error ${event.id}: ${String(error)}`);
      }
    });
  }
}
