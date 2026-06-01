import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { createEventInboxStore, type EventInboxStore } from './event-inbox.js';

const tempDirs: string[] = [];
let store: EventInboxStore | null = null;

function makeStore(): EventInboxStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'event-inbox-'));
  tempDirs.push(dir);
  store = createEventInboxStore(path.join(dir, 'event-inbox.db'));
  return store;
}

afterEach(() => {
  store?.close();
  store = null;
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('event inbox store', () => {
  it('stores durable events and lists only the owning agent inbox', () => {
    const inbox = makeStore();

    const event = inbox.emitEvent({
      source: 'github',
      sourceEventId: 'delivery-1',
      eventType: 'issues',
      ownerAgent: 'eli',
      routeKey: 'github:jeremys-labs/tmux-mcc:issues',
      summary: 'new issue',
      payload: { issue: { number: 12 } },
    });

    expect(event.duplicate).toBe(false);
    expect(inbox.listInbox({ agent: 'eli' })).toMatchObject([
      { id: event.id, status: 'new', summary: 'new issue', payload: { issue: { number: 12 } } },
    ]);
    expect(inbox.listInbox({ agent: 'zara' })).toEqual([]);
  });

  it('dedupes repeated source deliveries by dedupe key', () => {
    const inbox = makeStore();

    const first = inbox.emitEvent({
      source: 'github',
      sourceEventId: 'delivery-1',
      eventType: 'issues',
      ownerAgent: 'eli',
      routeKey: 'github:jeremys-labs/tmux-mcc:issues',
      summary: 'new issue',
      payload: {},
    });
    const second = inbox.emitEvent({
      source: 'github',
      sourceEventId: 'delivery-1',
      eventType: 'issues',
      ownerAgent: 'eli',
      routeKey: 'github:jeremys-labs/tmux-mcc:issues',
      summary: 'new issue again',
      payload: {},
    });

    expect(second.duplicate).toBe(true);
    expect(second.id).toBe(first.id);
    expect(inbox.listInbox({ agent: 'eli' })).toHaveLength(1);
  });

  it('acks and closes events without exposing them to other agents', () => {
    const inbox = makeStore();
    const event = inbox.emitEvent({
      source: 'runtime-health',
      sourceEventId: 'health-1',
      eventType: 'schedulerHeartbeat',
      ownerAgent: 'marcus',
      routeKey: 'runtime-health:schedulerHeartbeat',
      summary: 'scheduler heartbeat stale',
      payload: {},
      priority: 'high',
    });

    expect(() => inbox.ackEvent('eli', event.id)).toThrow('not found');
    expect(inbox.ackEvent('marcus', event.id)).toMatchObject({ status: 'acked' });
    expect(inbox.closeEvent('marcus', event.id, { resolved: true })).toMatchObject({
      status: 'closed',
      outcome: { resolved: true },
    });
    expect(inbox.listInbox({ agent: 'marcus' })).toEqual([]);
    expect(inbox.listInbox({ agent: 'marcus', status: 'closed' })).toHaveLength(1);
  });
});
