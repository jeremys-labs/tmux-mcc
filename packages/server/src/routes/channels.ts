import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

const AGENT_MAIL_LIMIT = 100;

function queryAgentMail(dbPath: string): Array<Record<string, unknown>> {
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db.prepare(`
      SELECT from_agent, to_agent, type, subject, created_at
      FROM messages
      ORDER BY created_at DESC
      LIMIT ?
    `).all(AGENT_MAIL_LIMIT) as Array<{ from_agent: string; to_agent: string; type: string; subject: string; created_at: string }>;

    return rows.map((r) => ({
      from: r.from_agent,
      to: r.to_agent,
      type: r.type,
      content: r.subject,
      timestamp: new Date(r.created_at).getTime(),
    }));
  } finally {
    db.close();
  }
}

export function createChannelRoutes(contentRoot: string): Router {
  const router = Router();

  const agentMailDb = process.env.AGENT_MAIL_DB;

  const legacyPaths = [
    path.join(contentRoot, 'workspace', 'memory', 'agent-interactions.json'),
    path.join(contentRoot, 'memory', 'agent-interactions.json'),
  ];

  router.get('/channels', (_req, res) => {
    // Primary: agent_mail.db
    if (agentMailDb && fs.existsSync(agentMailDb)) {
      try {
        const interactions = queryAgentMail(agentMailDb);
        res.json({ interactions });
        return;
      } catch {
        // fall through to legacy
      }
    }

    // Fallback: static JSON
    for (const p of legacyPaths) {
      try {
        if (!fs.existsSync(p)) continue;
        const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
        res.json(data);
        return;
      } catch {
        continue;
      }
    }

    res.json({ interactions: [] });
  });

  return router;
}
