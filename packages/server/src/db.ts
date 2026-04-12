import Database from 'better-sqlite3';

export interface ChatDB {
  addMessage(agent: string, role: string, content: string, timestamp: number, idempotencyKey?: string, metadata?: Record<string, unknown>): { seq: number; duplicate: boolean };
  getMessages(agent: string, limit?: number): Array<{ seq: number; agent: string; role: string; content: string; timestamp: number; metadata?: string }>;
  getMessagesBefore(agent: string, beforeSeq: number, limit: number): Array<{ seq: number; agent: string; role: string; content: string; timestamp: number; metadata?: string }>;
  getMessagesSince(agent: string, sinceSeq: number): Array<{ seq: number; agent: string; role: string; content: string; timestamp: number }>;
  clearMessages(agent: string): void;
  close(): void;
}

const DEDUP_WINDOW_MS = 10_000;

export function createChatDB(dbPath: string): ChatDB {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      agent TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      idempotency_key TEXT,
      metadata TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_messages_agent ON messages(agent);
    CREATE INDEX IF NOT EXISTS idx_messages_idempotency ON messages(idempotency_key);
  `);

  const insertStmt = db.prepare(
    'INSERT INTO messages (agent, role, content, timestamp, idempotency_key, metadata) VALUES (?, ?, ?, ?, ?, ?)'
  );

  const findByIdempotencyKey = db.prepare(
    'SELECT seq FROM messages WHERE idempotency_key = ?'
  );

  const findByContentProximity = db.prepare(
    'SELECT seq FROM messages WHERE agent = ? AND role = ? AND content = ? AND ABS(timestamp - ?) < ?'
  );

  const selectByAgent = db.prepare(
    'SELECT seq, agent, role, content, timestamp, metadata FROM messages WHERE agent = ? ORDER BY seq ASC'
  );

  const selectByAgentLimited = db.prepare(
    // Grab last N rows by selecting in DESC order then reversing — keeps chronological order
    'SELECT * FROM (SELECT seq, agent, role, content, timestamp, metadata FROM messages WHERE agent = ? ORDER BY seq DESC LIMIT ?) ORDER BY seq ASC'
  );

  const selectBefore = db.prepare(
    'SELECT * FROM (SELECT seq, agent, role, content, timestamp, metadata FROM messages WHERE agent = ? AND seq < ? ORDER BY seq DESC LIMIT ?) ORDER BY seq ASC'
  );

  const selectSince = db.prepare(
    'SELECT seq, agent, role, content, timestamp FROM messages WHERE agent = ? AND seq > ? ORDER BY seq ASC'
  );

  const deleteByAgent = db.prepare(
    'DELETE FROM messages WHERE agent = ?'
  );

  return {
    addMessage(agent, role, content, timestamp, idempotencyKey?, metadata?) {
      // Check idempotency key dedup
      if (idempotencyKey) {
        const existing = findByIdempotencyKey.get(idempotencyKey) as { seq: number } | undefined;
        if (existing) {
          return { seq: existing.seq, duplicate: true };
        }
      }

      // Check content + timestamp proximity dedup
      const contentDup = findByContentProximity.get(agent, role, content, timestamp, DEDUP_WINDOW_MS) as { seq: number } | undefined;
      if (contentDup) {
        return { seq: contentDup.seq, duplicate: true };
      }

      const metadataStr = metadata ? JSON.stringify(metadata) : null;
      const result = insertStmt.run(agent, role, content, timestamp, idempotencyKey || null, metadataStr);
      return { seq: Number(result.lastInsertRowid), duplicate: false };
    },

    getMessages(agent, limit?) {
      if (limit && limit > 0) {
        return selectByAgentLimited.all(agent, limit) as Array<{ seq: number; agent: string; role: string; content: string; timestamp: number; metadata?: string }>;
      }
      return selectByAgent.all(agent) as Array<{ seq: number; agent: string; role: string; content: string; timestamp: number; metadata?: string }>;
    },

    getMessagesBefore(agent, beforeSeq, limit) {
      return selectBefore.all(agent, beforeSeq, limit) as Array<{ seq: number; agent: string; role: string; content: string; timestamp: number; metadata?: string }>;
    },

    getMessagesSince(agent, sinceSeq) {
      return selectSince.all(agent, sinceSeq) as Array<{ seq: number; agent: string; role: string; content: string; timestamp: number }>;
    },

    clearMessages(agent) {
      deleteByAgent.run(agent);
    },

    close() {
      db.close();
    },
  };
}
