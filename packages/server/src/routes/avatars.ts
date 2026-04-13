import { Router } from 'express';
import type { Request, Response } from 'express';
import fs from 'fs';
import path from 'path';

const AGENTS_DIR = process.env.AGENTS_DIR ?? path.join(process.env.HOME || '', '.tmux-mcc', 'agents');
const EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif'];

export function createAvatarRouter(): Router {
  const router = Router();

  router.get('/agents/:agentKey/avatar', (req: Request, res: Response) => {
    const agentKey = req.params['agentKey'] as string;
    // Guard against path traversal
    if (!/^[a-zA-Z0-9_-]+$/.test(agentKey)) {
      res.status(400).end();
      return;
    }

    for (const ext of EXTENSIONS) {
      const filePath = path.join(AGENTS_DIR, agentKey, `avatar.${ext}`);
      if (fs.existsSync(filePath)) {
        res.sendFile(filePath);
        return;
      }
    }

    res.status(404).end();
  });

  return router;
}
