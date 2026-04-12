import { Router } from 'express';
import fs from 'fs';
import path from 'path';

interface DirEntry {
  name: string;
  type: 'file' | 'directory';
  size?: number;
}

export function createFileRoutes(contentRoot: string): Router {
  const router = Router();
  const filesDir = path.join(contentRoot, 'files');
  const docsDir = path.join(contentRoot, 'workspace', 'docs');

  // List files in review folders (inbox/approved/archive)
  router.get('/files', (_req, res) => {
    const result: Record<string, string[]> = {};
    for (const folder of ['inbox', 'approved', 'archive']) {
      const dir = path.join(filesDir, folder);
      try {
        result[folder] = fs.readdirSync(dir).filter((f) => !f.startsWith('.'));
      } catch {
        result[folder] = [];
      }
    }
    res.json(result);
  });

  // Browse workspace docs directory tree
  // GET /api/docs?path=relative/path (defaults to root)
  router.get('/docs', (req, res) => {
    const relPath = (req.query.path as string) || '';
    const absPath = path.join(docsDir, relPath);

    // Prevent path traversal
    if (!absPath.startsWith(docsDir)) {
      res.status(400).json({ error: 'Invalid path' });
      return;
    }

    if (!fs.existsSync(absPath)) {
      res.status(404).json({ error: 'Path not found' });
      return;
    }

    const stat = fs.statSync(absPath);
    if (stat.isDirectory()) {
      const entries: DirEntry[] = fs.readdirSync(absPath)
        .filter((f) => !f.startsWith('.'))
        .map((name) => {
          const s = fs.statSync(path.join(absPath, name));
          return {
            name,
            type: s.isDirectory() ? 'directory' as const : 'file' as const,
            size: s.isFile() ? s.size : undefined,
          };
        })
        .sort((a, b) => {
          // Directories first, then alphabetical
          if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
      res.json({ path: relPath, entries });
    } else {
      // Serve file content with appropriate content type
      const ext = path.extname(absPath).toLowerCase();
      const mimeTypes: Record<string, string> = {
        '.md': 'text/plain; charset=utf-8',
        '.txt': 'text/plain; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
        '.html': 'text/html; charset=utf-8',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.svg': 'image/svg+xml',
        '.webp': 'image/webp',
        '.pdf': 'application/pdf',
      };
      const contentType = mimeTypes[ext] || 'text/plain; charset=utf-8';
      res.setHeader('Content-Type', contentType);
      fs.createReadStream(absPath).pipe(res);
    }
  });

  // Serve a specific file from review folders
  router.get('/files/:folder/:filename', (req, res) => {
    const { folder, filename } = req.params;
    if (!['inbox', 'approved', 'archive'].includes(folder as string)) {
      res.status(400).json({ error: 'Invalid folder' });
      return;
    }
    const filePath = path.join(filesDir, folder as string, filename as string);
    if (!fs.existsSync(filePath)) {
      res.status(404).json({ error: 'File not found' });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes: Record<string, string> = {
      '.md': 'text/plain; charset=utf-8',
      '.txt': 'text/plain; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.html': 'text/html; charset=utf-8',
      '.htm': 'text/html; charset=utf-8',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.svg': 'image/svg+xml',
      '.webp': 'image/webp',
      '.pdf': 'application/pdf',
      '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      '.ppt': 'application/vnd.ms-powerpoint',
      '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.doc': 'application/msword',
      '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      '.xls': 'application/vnd.ms-excel',
      '.zip': 'application/zip',
      '.csv': 'text/csv; charset=utf-8',
    };
    const contentType = mimeTypes[ext] || 'application/octet-stream';
    res.setHeader('Content-Type', contentType);
    res.sendFile(filePath);
  });

  // Move file between review folders
  router.post('/files/:folder/:filename/move', (req, res) => {
    const { folder, filename } = req.params;
    const { to } = req.body;
    if (!['inbox', 'approved', 'archive'].includes(to)) {
      res.status(400).json({ error: 'Invalid destination' });
      return;
    }
    const src = path.join(filesDir, folder as string, filename as string);
    const dest = path.join(filesDir, to, filename as string);
    try {
      fs.renameSync(src, dest);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}
