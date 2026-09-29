import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { searchAgentMail } from './agent-mail-search.js';

let dbPath: string;

function seedMessage(db: Database.Database, overrides: Partial<{
  id: string; correlationId: string; fromAgent: string; toAgent: string;
  type: string; subject: string; bodyMd: string; createdAt: string;
}>): void {
  const row = {
    id: 'msg_1',
    correlationId: 'corr_1',
    fromAgent: 'marcus',
    toAgent: 'eli',
    type: 'note',
    subject: 'Subject',
    bodyMd: 'Body',
    createdAt: '2026-05-12T22:00:00.000Z',
    ...overrides,
  };
  db.prepare(`
    INSERT INTO messages (id, correlation_id, from_agent, to_agent, type, priority, subject, body_md, requires_response, status, created_at)
    VALUES (@id, @correlationId, @fromAgent, @toAgent, @type, 'normal', @subject, @bodyMd, 0, 'new', @createdAt)
  `).run(row);
}

beforeEach(() => {
  dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-mail-search-')), 'agent_mail.db');
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      correlation_id TEXT NOT NULL,
      from_agent TEXT NOT NULL,
      to_agent TEXT NOT NULL,
      type TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'normal',
      subject TEXT NOT NULL,
      body_md TEXT NOT NULL,
      related_project TEXT,
      requires_response INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'new',
      created_at TEXT NOT NULL,
      acked_at TEXT,
      closed_at TEXT
    );
  `);
  seedMessage(db, {
    id: 'msg_bridge',
    correlationId: 'corr_bridge',
    fromAgent: 'marcus',
    toAgent: 'eli',
    subject: 'Discord bridge redelivery',
    bodyMd: 'The bridge re-delivers inbound messages after compaction.',
    createdAt: '2026-09-19T00:00:00.000Z',
  });
  seedMessage(db, {
    id: 'msg_unrelated',
    correlationId: 'corr_unrelated',
    fromAgent: 'isla',
    toAgent: 'zara',
    subject: 'Weekly loop status',
    bodyMd: 'Nothing to do with bridges or delivery today.',
    createdAt: '2026-09-20T00:00:00.000Z',
  });
  seedMessage(db, {
    id: 'msg_other_agent',
    correlationId: 'corr_other',
    fromAgent: 'isla',
    toAgent: 'marcus',
    subject: 'Bridge follow-up',
    bodyMd: 'Another bridge mention, but not addressed to eli.',
    createdAt: '2026-09-21T00:00:00.000Z',
  });
  db.close();
});

afterEach(() => {
  fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
});

describe('searchAgentMail', () => {
  it('finds messages matching a keyword in subject or body', () => {
    const results = searchAgentMail('bridge', { dbPath });
    const ids = results.map((r) => r.id).sort();
    expect(ids).toEqual(['msg_bridge', 'msg_other_agent']);
  });

  it('excludes messages that do not match the query', () => {
    const results = searchAgentMail('bridge', { dbPath });
    expect(results.some((r) => r.id === 'msg_unrelated')).toBe(false);
  });

  it('filters to messages involving a given agent', () => {
    const results = searchAgentMail('bridge', { dbPath, agent: 'eli' });
    expect(results.map((r) => r.id)).toEqual(['msg_bridge']);
  });

  it('returns an empty array for a blank query without touching the database', () => {
    expect(searchAgentMail('   ', { dbPath: '/nonexistent/path.db' })).toEqual([]);
  });

  it('does not mutate the source database', () => {
    const before = fs.statSync(dbPath).mtimeMs;
    searchAgentMail('bridge', { dbPath });
    const db = new Database(dbPath, { readonly: true });
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    db.close();
    expect(tables.map((t: any) => t.name)).toEqual(['messages']);
    expect(fs.statSync(dbPath).mtimeMs).toBe(before);
  });
});
