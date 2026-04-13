import { Router } from 'express';
import type { Request, Response } from 'express';
import { agentStatusBroadcaster } from '../services/agent-status-broadcaster.js';

export function createAgentStatusRouter(): Router {
  const router = Router();

  router.get('/agent-status/stream', (req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    agentStatusBroadcaster.addClient(res);

    req.on('close', () => {
      agentStatusBroadcaster.removeClient(res);
    });
  });

  return router;
}
