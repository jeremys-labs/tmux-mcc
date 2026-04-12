import { Router } from 'express';
import fs from 'fs';
import path from 'path';

export function createChannelRoutes(contentRoot: string): Router {
  const router = Router();
  const interactionsPaths = [
    path.join(contentRoot, 'workspace', 'memory', 'agent-interactions.json'),
    path.join(contentRoot, 'memory', 'agent-interactions.json'),
  ];

  router.get('/channels', (_req, res) => {
    for (const p of interactionsPaths) {
      try {
        if (!fs.existsSync(p)) continue;
        const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
        res.json(data);
        return;
      } catch {
        continue;
      }
    }
    res.json({ channels: [], interactions: [] });
  });

  return router;
}
