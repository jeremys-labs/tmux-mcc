import { Router } from 'express';
import Database from 'better-sqlite3';
import { resolveAgentMailDbPath } from '@agent-comms/mailbox';
import fs from 'fs';
import path from 'path';

interface MailRow {
  from_agent: string;
  to_agent: string;
  type: string;
  subject: string;
  body_md: string;
  created_at: string;
}

export interface ChannelInteraction {
  from: string;
  to: string;
  type: string;
  subject: string;
  content: string;
  timestamp: string;
}

export function listAgentMailMessages(limit = 200): ChannelInteraction[] {
  const dbPath = resolveAgentMailDbPath();
  if (!fs.existsSync(dbPath)) return [];
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db
      .prepare(
        'SELECT from_agent, to_agent, type, subject, body_md, created_at FROM messages ORDER BY created_at DESC LIMIT ?'
      )
      .all(limit) as MailRow[];
    return rows.map((r) => ({
      from: r.from_agent,
      to: r.to_agent,
      type: r.type,
      subject: r.subject,
      content: r.body_md,
      timestamp: r.created_at,
    }));
  } finally {
    db.close();
  }
}

export function createChannelRoutes(contentRoot: string): Router {
  const router = Router();

  router.get('/channels', (_req, res) => {
    const interactions = listAgentMailMessages();

    // Fell through — no agent-mail DB yet; return the legacy file if it exists
    if (interactions.length === 0) {
      const legacyPaths = [
        path.join(contentRoot, 'workspace', 'memory', 'agent-interactions.json'),
        path.join(contentRoot, 'memory', 'agent-interactions.json'),
      ];
      for (const p of legacyPaths) {
        try {
          if (!fs.existsSync(p)) continue;
          const data = JSON.parse(fs.readFileSync(p, 'utf-8')) as unknown;
          res.json(data);
          return;
        } catch {
          continue;
        }
      }
    }

    res.json({ interactions });
  });

  return router;
}
