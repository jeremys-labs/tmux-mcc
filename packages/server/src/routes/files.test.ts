import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFileRoutes } from './files.js';

function findHandler(router: ReturnType<typeof createFileRoutes>, method: string, routePath: string) {
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
      setHeader() {},
      sendFile(filePath: string) {
        resolve({ status: 200, sentFile: filePath });
      },
    };
    handler(req, res, () => resolve({ status: 'next' }));
  });
}

describe('file routes path traversal guard', () => {
  let contentRoot: string;
  let docsDir: string;
  let secretFile: string;

  beforeEach(() => {
    contentRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcc-files-test-'));
    docsDir = path.join(contentRoot, 'docs');
    fs.mkdirSync(path.join(contentRoot, 'files', 'inbox'), { recursive: true });
    fs.mkdirSync(path.join(contentRoot, 'files', 'approved'), { recursive: true });
    fs.mkdirSync(docsDir, { recursive: true });
    secretFile = path.join(contentRoot, '.env');
    fs.writeFileSync(secretFile, 'SECRET=1');
    fs.writeFileSync(path.join(contentRoot, 'files', 'inbox', 'real.txt'), 'hello');
  });

  afterEach(() => {
    fs.rmSync(contentRoot, { recursive: true, force: true });
  });

  it('rejects ..-traversal on GET /files/:folder/:filename instead of serving files outside filesDir', async () => {
    const router = createFileRoutes(contentRoot, docsDir);
    const handler = findHandler(router, 'get', '/files/:folder/:filename');
    const result = await invoke(handler, { params: { folder: 'inbox', filename: '../../.env' } });
    expect(result.sentFile).toBeUndefined();
    expect(result.status).toBe(400);
  });

  it('still serves a legitimate file inside the folder', async () => {
    const router = createFileRoutes(contentRoot, docsDir);
    const handler = findHandler(router, 'get', '/files/:folder/:filename');
    const result = await invoke(handler, { params: { folder: 'inbox', filename: 'real.txt' } });
    expect(result.sentFile).toBe(path.join(contentRoot, 'files', 'inbox', 'real.txt'));
  });

  it('rejects ..-traversal on POST /files/:folder/:filename/move for both src and dest', async () => {
    const router = createFileRoutes(contentRoot, docsDir);
    const handler = findHandler(router, 'post', '/files/:folder/:filename/move');
    const result = await invoke(handler, {
      params: { folder: 'inbox', filename: '../../.env' },
      body: { to: 'approved' },
    });
    expect(result.status).toBe(400);
    expect(fs.existsSync(secretFile)).toBe(true);
  });

  it('rejects an invalid source folder on move instead of joining it unchecked', async () => {
    const router = createFileRoutes(contentRoot, docsDir);
    const handler = findHandler(router, 'post', '/files/:folder/:filename/move');
    const result = await invoke(handler, {
      params: { folder: '..', filename: '.env' },
      body: { to: 'approved' },
    });
    expect(result.status).toBe(400);
  });
});
