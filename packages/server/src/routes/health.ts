import { Router } from 'express';
import {
  fetchAgentSupervisorStatus,
  planAgentSupervisorCommand,
  type AgentSupervisorCommandRequest,
} from '../services/agent-supervisor-client.js';

export function createHealthRouter(): Router {
  const router = Router();

  router.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      timestamp: Date.now(),
    });
  });

  router.get('/supervisor/status', async (_req, res) => {
    try {
      res.json(await fetchAgentSupervisorStatus());
    } catch (error) {
      res.status(503).json({
        status: 'unavailable',
        service: 'agent-supervisor',
        error: String(error),
      });
    }
  });

  router.post('/supervisor/commands/plan', async (req, res) => {
    try {
      res.json(await planAgentSupervisorCommand(req.body as AgentSupervisorCommandRequest));
    } catch (error) {
      res.status(503).json({
        status: 'unavailable',
        service: 'agent-supervisor',
        error: String(error),
      });
    }
  });

  return router;
}
