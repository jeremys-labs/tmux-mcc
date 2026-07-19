import path from 'path';
import { createEventInboxStore, type EventInboxStore } from '@agent-comms/event-inbox';

/** Single source of truth for the shared event-inbox DB path. */
export function resolveEventInboxDbPath(contentRoot: string): string {
  return path.join(contentRoot, 'databases', 'event-inbox.db');
}

/**
 * Open the durable event-inbox store rooted at the content root. The webhook server (writer)
 * and each runtime wrapper (reader/acker) all open the same DB, so they must agree on this path.
 */
export function openEventInboxStore(contentRoot: string): EventInboxStore {
  return createEventInboxStore(resolveEventInboxDbPath(contentRoot));
}
