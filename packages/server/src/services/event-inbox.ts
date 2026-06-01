import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

export type EventInboxPriority = 'low' | 'normal' | 'high';
export type EventInboxRisk = 'low' | 'medium' | 'high';
export type EventInboxStatus = 'new' | 'acked' | 'closed' | 'failed';

export interface EmitEventInput {
  source: string;
  sourceEventId: string;
  eventType: string;
  ownerAgent: string;
  routeKey: string;
  summary: string;
  payload: unknown;
  occurredAt?: string | null;
  priority?: EventInboxPriority;
  risk?: EventInboxRisk;
  dedupeKey?: string;
}

export interface EventInboxRecord {
  id: number;
  source: string;
  sourceEventId: string;
  eventType: string;
  receivedAt: string;
  occurredAt: string | null;
  ownerAgent: string;
  routeKey: string;
  priority: EventInboxPriority;
  risk: EventInboxRisk;
  status: EventInboxStatus;
  dedupeKey: string;
  summary: string;
  payload: unknown;
  attempts: number;
  lastError: string | null;
  ackedAt: string | null;
  closedAt: string | null;
  outcome: unknown;
}

export interface EventInboxStore {
  emitEvent(input: EmitEventInput): EventInboxRecord & { duplicate: boolean };
  listInbox(options: { agent: string; status?: EventInboxStatus }): EventInboxRecord[];
  ackEvent(agent: string, id: number): EventInboxRecord;
  closeEvent(agent: string, id: number, outcome?: unknown): EventInboxRecord;
  close(): void;
}

interface EventInboxRow {
  id: number;
  source: string;
  source_event_id: string;
  event_type: string;
  received_at: string;
  occurred_at: string | null;
  owner_agent: string;
  route_key: string;
  priority: EventInboxPriority;
  risk: EventInboxRisk;
  status: EventInboxStatus;
  dedupe_key: string;
  summary: string;
  payload_json: string;
  attempts: number;
  last_error: string | null;
  acked_at: string | null;
  closed_at: string | null;
  outcome_json: string | null;
}

function nowIso(): string {
  return new Date().toISOString();
}

function parseJson(value: string | null): unknown {
  if (!value) return null;
  return JSON.parse(value);
}

function rowToRecord(row: EventInboxRow): EventInboxRecord {
  return {
    id: row.id,
    source: row.source,
    sourceEventId: row.source_event_id,
    eventType: row.event_type,
    receivedAt: row.received_at,
    occurredAt: row.occurred_at,
    ownerAgent: row.owner_agent,
    routeKey: row.route_key,
    priority: row.priority,
    risk: row.risk,
    status: row.status,
    dedupeKey: row.dedupe_key,
    summary: row.summary,
    payload: parseJson(row.payload_json),
    attempts: row.attempts,
    lastError: row.last_error,
    ackedAt: row.acked_at,
    closedAt: row.closed_at,
    outcome: parseJson(row.outcome_json),
  };
}

export function createEventInboxStore(dbPath: string): EventInboxStore {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS event_inbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      source_event_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      received_at TEXT NOT NULL,
      occurred_at TEXT,
      owner_agent TEXT NOT NULL,
      route_key TEXT NOT NULL,
      priority TEXT NOT NULL,
      risk TEXT NOT NULL,
      status TEXT NOT NULL,
      dedupe_key TEXT NOT NULL UNIQUE,
      summary TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      acked_at TEXT,
      closed_at TEXT,
      outcome_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_event_inbox_owner_status ON event_inbox(owner_agent, status, id);
    CREATE INDEX IF NOT EXISTS idx_event_inbox_route ON event_inbox(route_key, id);
  `);

  const insertEvent = db.prepare(`
    INSERT INTO event_inbox (
      source, source_event_id, event_type, received_at, occurred_at, owner_agent,
      route_key, priority, risk, status, dedupe_key, summary, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, ?)
  `);

  const selectByDedupe = db.prepare('SELECT * FROM event_inbox WHERE dedupe_key = ?');
  const selectByIdAndAgent = db.prepare('SELECT * FROM event_inbox WHERE id = ? AND owner_agent = ?');
  const selectInbox = db.prepare(`
    SELECT * FROM event_inbox
    WHERE owner_agent = ? AND status = ?
    ORDER BY id ASC
  `);
  const ackById = db.prepare(`
    UPDATE event_inbox
    SET status = 'acked', acked_at = ?
    WHERE id = ? AND owner_agent = ? AND status = 'new'
  `);
  const closeById = db.prepare(`
    UPDATE event_inbox
    SET status = 'closed', closed_at = ?, outcome_json = ?
    WHERE id = ? AND owner_agent = ? AND status IN ('new', 'acked', 'failed')
  `);

  function getOwnedRecord(agent: string, id: number): EventInboxRecord {
    const row = selectByIdAndAgent.get(id, agent) as EventInboxRow | undefined;
    if (!row) {
      throw new Error(`event ${id} not found for ${agent}`);
    }
    return rowToRecord(row);
  }

  return {
    emitEvent(input) {
      const dedupeKey = input.dedupeKey ?? `${input.source}:${input.eventType}:${input.sourceEventId}`;
      const existing = selectByDedupe.get(dedupeKey) as EventInboxRow | undefined;
      if (existing) {
        return { ...rowToRecord(existing), duplicate: true };
      }

      insertEvent.run(
        input.source,
        input.sourceEventId,
        input.eventType,
        nowIso(),
        input.occurredAt ?? null,
        input.ownerAgent,
        input.routeKey,
        input.priority ?? 'normal',
        input.risk ?? 'low',
        dedupeKey,
        input.summary,
        JSON.stringify(input.payload)
      );

      const row = selectByDedupe.get(dedupeKey) as EventInboxRow;
      return { ...rowToRecord(row), duplicate: false };
    },

    listInbox(options) {
      return (selectInbox.all(options.agent, options.status ?? 'new') as EventInboxRow[]).map(rowToRecord);
    },

    ackEvent(agent, id) {
      ackById.run(nowIso(), id, agent);
      return getOwnedRecord(agent, id);
    },

    closeEvent(agent, id, outcome) {
      closeById.run(nowIso(), outcome === undefined ? null : JSON.stringify(outcome), id, agent);
      return getOwnedRecord(agent, id);
    },

    close() {
      db.close();
    },
  };
}
