import Database from 'better-sqlite3';

const DEFAULT_AGENT_MAIL_DB = '/Volumes/Repo-Drive/agents/SHARED/agent-mail/agent_mail.db';

export interface AgentMailSearchResult {
  id: string;
  correlationId: string;
  fromAgent: string;
  toAgent: string;
  type: string;
  subject: string;
  snippet: string;
  createdAt: string;
}

export interface AgentMailSearchOptions {
  agent?: string;
  limit?: number;
  dbPath?: string;
}

/**
 * Read-only keyword search over agent-mail history. Opens the store in
 * readonly mode and builds a throwaway in-memory FTS5 index per call, so it
 * never mutates the live mailbox database or its schema.
 */
export function searchAgentMail(query: string, options: AgentMailSearchOptions = {}): AgentMailSearchResult[] {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) return [];

  const dbPath = options.dbPath ?? DEFAULT_AGENT_MAIL_DB;
  const limit = options.limit ?? 20;

  const source = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const index = new Database(':memory:');
    try {
      index.exec(`
        CREATE VIRTUAL TABLE messages_fts USING fts5(
          id UNINDEXED, correlation_id UNINDEXED, from_agent UNINDEXED,
          to_agent UNINDEXED, type UNINDEXED, created_at UNINDEXED,
          subject, body_md
        );
      `);

      const rows = source
        .prepare('SELECT id, correlation_id, from_agent, to_agent, type, subject, body_md, created_at FROM messages')
        .all() as Array<{
          id: string; correlation_id: string; from_agent: string; to_agent: string;
          type: string; subject: string; body_md: string; created_at: string;
        }>;

      const insert = index.prepare(`
        INSERT INTO messages_fts (id, correlation_id, from_agent, to_agent, type, created_at, subject, body_md)
        VALUES (@id, @correlation_id, @from_agent, @to_agent, @type, @created_at, @subject, @body_md)
      `);
      const insertMany = index.transaction((records: typeof rows) => {
        for (const record of records) insert.run(record);
      });
      insertMany(rows);

      const agentFilter = options.agent
        ? 'AND (from_agent = @agent OR to_agent = @agent)'
        : '';

      const results = index
        .prepare(`
          SELECT id, correlation_id, from_agent, to_agent, type, created_at, subject,
                 snippet(messages_fts, 7, '[', ']', '...', 12) AS snippet
          FROM messages_fts
          WHERE messages_fts MATCH @query ${agentFilter}
          ORDER BY rank
          LIMIT @limit
        `)
        .all({ query: trimmedQuery, agent: options.agent ?? '', limit }) as Array<{
          id: string; correlation_id: string; from_agent: string; to_agent: string;
          type: string; created_at: string; subject: string; snippet: string;
        }>;

      return results.map((row) => ({
        id: row.id,
        correlationId: row.correlation_id,
        fromAgent: row.from_agent,
        toAgent: row.to_agent,
        type: row.type,
        subject: row.subject,
        snippet: row.snippet,
        createdAt: row.created_at,
      }));
    } finally {
      index.close();
    }
  } finally {
    source.close();
  }
}
