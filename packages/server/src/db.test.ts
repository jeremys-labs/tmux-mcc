import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createChatDB, type ChatDB } from './db.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('ChatDB', () => {
  let tmpDir: string;
  let db: ChatDB;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcc-db-'));
    db = createChatDB(path.join(tmpDir, 'chat.db'));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true });
  });

  it('inserts and retrieves messages', () => {
    const now = Date.now();
    const result = db.addMessage('alice', 'user', 'Hello', now);
    expect(result.seq).toBe(1);
    expect(result.duplicate).toBe(false);

    const result2 = db.addMessage('alice', 'assistant', 'Hi there', now + 20_000);
    expect(result2.seq).toBe(2);

    const messages = db.getMessages('alice');
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toBe('Hello');
    expect(messages[0].role).toBe('user');
    expect(messages[1].content).toBe('Hi there');
    expect(messages[1].role).toBe('assistant');
  });

  it('deduplicates by idempotency key', () => {
    const now = Date.now();
    const r1 = db.addMessage('alice', 'user', 'Hello', now, 'key-1');
    expect(r1.duplicate).toBe(false);
    expect(r1.seq).toBe(1);

    const r2 = db.addMessage('alice', 'user', 'Hello', now + 60_000, 'key-1');
    expect(r2.duplicate).toBe(true);
    expect(r2.seq).toBe(1);

    const messages = db.getMessages('alice');
    expect(messages).toHaveLength(1);
  });

  it('deduplicates by content and timestamp proximity', () => {
    const now = Date.now();
    const r1 = db.addMessage('alice', 'user', 'Hello', now);
    expect(r1.duplicate).toBe(false);

    // Same content within 10s window
    const r2 = db.addMessage('alice', 'user', 'Hello', now + 5_000);
    expect(r2.duplicate).toBe(true);
    expect(r2.seq).toBe(r1.seq);

    // Same content outside 10s window
    const r3 = db.addMessage('alice', 'user', 'Hello', now + 20_000);
    expect(r3.duplicate).toBe(false);
    expect(r3.seq).toBe(2);

    const messages = db.getMessages('alice');
    expect(messages).toHaveLength(2);
  });

  it('retrieves messages since a given seq', () => {
    const now = Date.now();
    db.addMessage('alice', 'user', 'msg1', now);
    db.addMessage('alice', 'assistant', 'msg2', now + 20_000);
    db.addMessage('alice', 'user', 'msg3', now + 40_000);

    const since = db.getMessagesSince('alice', 1);
    expect(since).toHaveLength(2);
    expect(since[0].content).toBe('msg2');
    expect(since[1].content).toBe('msg3');
  });

  it('clears messages for an agent', () => {
    const now = Date.now();
    db.addMessage('alice', 'user', 'Hello', now);
    db.addMessage('bob', 'user', 'Hey', now + 20_000);

    db.clearMessages('alice');

    expect(db.getMessages('alice')).toHaveLength(0);
    expect(db.getMessages('bob')).toHaveLength(1);
  });

  it('stores and retrieves metadata', () => {
    const now = Date.now();
    db.addMessage('alice', 'user', 'Hello', now, undefined, { source: 'web' });

    const messages = db.getMessages('alice');
    expect(messages[0].metadata).toBe('{"source":"web"}');
  });
});
