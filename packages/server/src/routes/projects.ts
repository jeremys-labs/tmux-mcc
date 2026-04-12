import { Router } from 'express';
import fs from 'fs';
import path from 'path';

export function createProjectsRouter(contentRoot: string): Router {
  const router = Router();

  const projectsPath = path.join(contentRoot, 'workspace', 'docs', 'projects', 'projects.json');

  router.get('/projects', (_req, res) => {
    try {
      if (!fs.existsSync(projectsPath)) {
        res.json([]);
        return;
      }
      const data = JSON.parse(fs.readFileSync(projectsPath, 'utf-8'));
      res.json(data);
    } catch {
      res.status(500).json({ error: 'Failed to read projects' });
    }
  });

  return router;
}
