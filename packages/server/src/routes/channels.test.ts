import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createChannelRoutes } from './channels.js';

function findHandler(router: ReturnType<typeof createChannelRoutes>, method: string, routePath: string) {
  const layer = router.stack.find((r: any) => r.route?.path === routePath && r.route?.methods?.[method]);
  const handler = layer?.route?.stack?.[0]?.handle;
  if (!handler) throw new Error(`Route handler not found: ${method} ${routePath}`);
  return handler;
}

function invoke(handler: any, req: any) {
  return new Promise<any>((resolve) => {
    const res = {
      status(code: number) {
        return { json: (data: any) => resolve({ status: code, data }) };
      },
      json(data: any) {
        resolve({ status: 200, data });
      },
    };
    handler(req, res, () => resolve({ status: 'next' }));
  });
}

function seedMailDb(dbPath: string, rows: Array<{ from: string; to: string; type: string; subject: string; createdAt: string }>) {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE messages (
      from_agent TEXT,
      to_agent TEXT,
      type TEXT,
      subject TEXT,
      created_at TEXT
    )
  `);
  const insert = db.prepare('INSERT INTO messages (from_agent, to_agent, type, subject, created_at) VALUES (?, ?, ?, ?, ?)');
  for (const r of rows) insert.run(r.from, r.to, r.type, r.subject, r.createdAt);
  db.close();
}

function get(contentRoot: string) {
  const router = createChannelRoutes(contentRoot);
  return invoke(findHandler(router, 'get', '/channels'), {});
}

describe('channel routes', () => {
  let tmp: string;
  let contentRoot: string;
  let dbPath: string;
  const originalEnv = process.env.AGENT_MAIL_DB;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'channels-test-'));
    contentRoot = path.join(tmp, 'content');
    fs.mkdirSync(contentRoot, { recursive: true });
    dbPath = path.join(tmp, 'agent_mail.db');
    delete process.env.AGENT_MAIL_DB;
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    if (originalEnv === undefined) delete process.env.AGENT_MAIL_DB;
    else process.env.AGENT_MAIL_DB = originalEnv;
  });

  it('serves agent_mail rows as interactions when the DB is present', async () => {
    seedMailDb(dbPath, [
      { from: 'marcus', to: 'eli', type: 'handoff', subject: 'PR ready', createdAt: '2026-05-12T10:00:00.000Z' },
    ]);
    process.env.AGENT_MAIL_DB = dbPath;

    const res = await get(contentRoot);

    expect(res.status).toBe(200);
    expect(res.data.interactions).toEqual([
      {
        from: 'marcus',
        to: 'eli',
        type: 'handoff',
        content: 'PR ready',
        timestamp: new Date('2026-05-12T10:00:00.000Z').getTime(),
      },
    ]);
  });

  it('returns newest first', async () => {
    seedMailDb(dbPath, [
      { from: 'older', to: 'x', type: 'note', subject: 'a', createdAt: '2026-05-12T10:00:00.000Z' },
      { from: 'newer', to: 'x', type: 'note', subject: 'b', createdAt: '2026-05-12T12:00:00.000Z' },
    ]);
    process.env.AGENT_MAIL_DB = dbPath;

    const res = await get(contentRoot);

    expect(res.data.interactions.map((i: any) => i.from)).toEqual(['newer', 'older']);
  });

  it('caps the result at the agent-mail limit', async () => {
    const rows = Array.from({ length: 150 }, (_, i) => ({
      from: 'a',
      to: 'b',
      type: 'note',
      subject: `msg ${i}`,
      createdAt: new Date(Date.UTC(2026, 4, 12, 0, 0, i)).toISOString(),
    }));
    seedMailDb(dbPath, rows);
    process.env.AGENT_MAIL_DB = dbPath;

    const res = await get(contentRoot);

    expect(res.data.interactions).toHaveLength(100);
  });

  it('falls back to the legacy JSON feed when no DB is configured', async () => {
    const legacyDir = path.join(contentRoot, 'workspace', 'memory');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(
      path.join(legacyDir, 'agent-interactions.json'),
      JSON.stringify({ interactions: [{ from: 'legacy', to: 'reader', type: 'note', content: 'from json' }] }),
    );

    const res = await get(contentRoot);

    expect(res.data.interactions[0].from).toBe('legacy');
  });

  it('falls back to the legacy feed when the configured DB is unreadable', async () => {
    fs.writeFileSync(dbPath, 'this is not a sqlite database');
    process.env.AGENT_MAIL_DB = dbPath;
    const legacyDir = path.join(contentRoot, 'memory');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(
      path.join(legacyDir, 'agent-interactions.json'),
      JSON.stringify({ interactions: [{ from: 'legacy', to: 'reader', type: 'note', content: 'fallback' }] }),
    );

    const res = await get(contentRoot);

    expect(res.data.interactions[0].content).toBe('fallback');
  });

  it('returns an empty list rather than erroring when no source exists', async () => {
    const res = await get(contentRoot);

    expect(res.status).toBe(200);
    expect(res.data).toEqual({ interactions: [] });
  });
});
