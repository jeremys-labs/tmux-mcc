import { Router, Request, Response } from 'express';
import { ChatDB } from '../db.js';

const SNIPPET_RADIUS = 48;

function countMatches(content: string, queryLower: string): number {
  return content.toLowerCase().split(queryLower).length - 1;
}

function buildSnippet(content: string, matchIndex: number, queryLength: number): string {
  const start = Math.max(0, matchIndex - SNIPPET_RADIUS);
  const end = Math.min(content.length, matchIndex + queryLength + SNIPPET_RADIUS);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < content.length ? '…' : '';
  return `${prefix}${content.slice(start, end).trim()}${suffix}`;
}

export function createSearchRouter(db: ChatDB): Router {
  const router = Router();

  /**
   * GET /api/search?agent=<agent>&q=<query>
   *
   * Search through an agent's message history.
   * Returns ranked messages where content (case-insensitive) contains the query string,
   * plus a contextual snippet for fast scanning.
   */
  router.get('/', (req: Request, res: Response) => {
    const agent = req.query.agent as string;
    const rawQuery = req.query.q as string;
    const query = rawQuery?.trim();

    if (!agent) {
      res.status(400).json({ error: 'agent parameter required' });
      return;
    }

    if (!query) {
      res.status(400).json({ error: 'q parameter required' });
      return;
    }

    const messages = db.getMessages(agent);
    const queryLower = query.toLowerCase();

    const results = messages
      .map((msg) => {
        const contentLower = msg.content.toLowerCase();
        const matchIndex = contentLower.indexOf(queryLower);
        if (matchIndex === -1) return null;

        const matchCount = countMatches(msg.content, queryLower);

        return {
          seq: msg.seq,
          role: msg.role,
          content: msg.content,
          timestamp: msg.timestamp,
          agent: msg.agent,
          matchIndex,
          matchCount,
          snippet: buildSnippet(msg.content, matchIndex, query.length),
        };
      })
      .filter((msg): msg is NonNullable<typeof msg> => !!msg)
      .sort((a, b) => {
        if (b.matchCount !== a.matchCount) return b.matchCount - a.matchCount;
        if (a.matchIndex !== b.matchIndex) return a.matchIndex - b.matchIndex;
        return b.timestamp - a.timestamp;
      });

    res.json({
      agent,
      query,
      total: results.length,
      results,
    });
  });

  return router;
}
