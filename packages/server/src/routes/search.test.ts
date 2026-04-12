import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express, { Express } from 'express';
import { createChatDB, ChatDB } from '../db.js';
import { createSearchRouter } from './search.js';
import path from 'path';
import fs from 'fs';
import os from 'os';

let app: Express;
let db: ChatDB;
let tmpDir: string;

beforeEach(() => {
  // Create temp DB for tests
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcc-search-test'));
  const dbPath = path.join(tmpDir, 'test.db');
  db = createChatDB(dbPath);

  // Setup Express app
  app = express();
  app.use(express.json());
  app.use('/api/search', createSearchRouter(db));

  // Add test data
  db.addMessage('alice', 'user', 'Tell me about machine learning', Date.now() - 5000, 'u1');
  db.addMessage('alice', 'assistant', 'Machine learning is a subset of artificial intelligence that focuses on algorithms learning from data.', Date.now() - 4000, 'a1');
  db.addMessage('alice', 'user', 'What about deep learning?', Date.now() - 3000, 'u2');
  db.addMessage('alice', 'assistant', 'Deep learning uses neural networks with multiple layers to process data.', Date.now() - 2000, 'a2');
  db.addMessage('bob', 'user', 'Hello Bob', Date.now() - 1000, 'u3');
  db.addMessage('bob', 'assistant', 'Hello! How can I help you?', Date.now(), 'a3');
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('Search Router', () => {
  it('should search messages by query and return contextual snippets', async () => {
    const res = await new Promise<any>((resolve) => {
      const mockRes = {
        json: (data: any) => resolve({ status: 200, data }),
        status: (code: number) => ({ json: (data: any) => resolve({ status: code, data }) }),
      };
      const mockReq = {
        query: { agent: 'alice', q: 'learning' },
      };
      const router = createSearchRouter(db);
      const handler = router.stack.find((r) => r.route?.path === '/')?.route?.stack[0].handle;
      if (handler) {
        handler(mockReq, mockRes, () => {});
      }
    });

    expect(res.status).toBe(200);
    expect(res.data.results).toHaveLength(4);
    expect(res.data.results.every((m: any) => m.content.toLowerCase().includes('learning'))).toBe(true);
    expect(res.data.results[0].snippet.toLowerCase()).toContain('learning');
    expect(res.data.results[0].matchIndex).toBeTypeOf('number');
    expect(res.data.results[0].matchCount).toBeGreaterThan(0);
  });

  it('should filter results by agent', async () => {
    const res = await new Promise<any>((resolve) => {
      const mockRes = {
        json: (data: any) => resolve({ status: 200, data }),
        status: (code: number) => ({ json: (data: any) => resolve({ status: code, data }) }),
      };
      const mockReq = {
        query: { agent: 'bob', q: 'hello' },
      };
      const router = createSearchRouter(db);
      const handler = router.stack.find((r) => r.route?.path === '/')?.route?.stack[0].handle;
      if (handler) {
        handler(mockReq, mockRes, () => {});
      }
    });

    expect(res.status).toBe(200);
    expect(res.data.results).toHaveLength(2);
    expect(res.data.results[0].agent).toBe('bob');
  });

  it('should return empty array for no matches', async () => {
    const res = await new Promise<any>((resolve) => {
      const mockRes = {
        json: (data: any) => resolve({ status: 200, data }),
        status: (code: number) => ({ json: (data: any) => resolve({ status: code, data }) }),
      };
      const mockReq = {
        query: { agent: 'alice', q: 'xyz123nonexistent' },
      };
      const router = createSearchRouter(db);
      const handler = router.stack.find((r) => r.route?.path === '/')?.route?.stack[0].handle;
      if (handler) {
        handler(mockReq, mockRes, () => {});
      }
    });

    expect(res.status).toBe(200);
    expect(res.data.results).toEqual([]);
  });

  it('should be case-insensitive and rank earlier matches first', async () => {
    db.addMessage(
      'alice',
      'assistant',
      'Learning matters when teams revisit learning loops and learning reviews.',
      Date.now() - 1500,
      'a4'
    );

    const res = await new Promise<any>((resolve) => {
      const mockRes = {
        json: (data: any) => resolve({ status: 200, data }),
        status: (code: number) => ({ json: (data: any) => resolve({ status: code, data }) }),
      };
      const mockReq = {
        query: { agent: 'alice', q: 'LEARNING' },
      };
      const router = createSearchRouter(db);
      const handler = router.stack.find((r) => r.route?.path === '/')?.route?.stack[0].handle;
      if (handler) {
        handler(mockReq, mockRes, () => {});
      }
    });

    expect(res.status).toBe(200);
    expect(res.data.results).toHaveLength(5);
    expect(res.data.results[0].content).toContain('Learning matters');
    expect(res.data.results[0].matchCount).toBe(3);
    expect(res.data.results[0].snippet).toContain('Learning matters');
  });

  it('should require agent parameter', async () => {
    const res = await new Promise<any>((resolve) => {
      const mockRes = {
        json: (data: any) => resolve({ status: 200, data }),
        status: (code: number) => ({ json: (data: any) => resolve({ status: code, data }) }),
      };
      const mockReq = {
        query: { q: 'learning' },
      };
      const router = createSearchRouter(db);
      const handler = router.stack.find((r) => r.route?.path === '/')?.route?.stack[0].handle;
      if (handler) {
        handler(mockReq, mockRes, () => {});
      }
    });

    expect(res.status).toBe(400);
  });

  it('should require search query parameter', async () => {
    const res = await new Promise<any>((resolve) => {
      const mockRes = {
        json: (data: any) => resolve({ status: 200, data }),
        status: (code: number) => ({ json: (data: any) => resolve({ status: code, data }) }),
      };
      const mockReq = {
        query: { agent: 'alice' },
      };
      const router = createSearchRouter(db);
      const handler = router.stack.find((r) => r.route?.path === '/')?.route?.stack[0].handle;
      if (handler) {
        handler(mockReq, mockRes, () => {});
      }
    });

    expect(res.status).toBe(400);
  });

  it('should reject whitespace-only queries', async () => {
    const res = await new Promise<any>((resolve) => {
      const mockRes = {
        json: (data: any) => resolve({ status: 200, data }),
        status: (code: number) => ({ json: (data: any) => resolve({ status: code, data }) }),
      };
      const mockReq = {
        query: { agent: 'alice', q: '   ' },
      };
      const router = createSearchRouter(db);
      const handler = router.stack.find((r) => r.route?.path === '/')?.route?.stack[0].handle;
      if (handler) {
        handler(mockReq, mockRes, () => {});
      }
    });

    expect(res.status).toBe(400);
    expect(res.data.error).toMatch(/q parameter required/i);
  });
});
