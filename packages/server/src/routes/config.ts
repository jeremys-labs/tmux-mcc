import { Router } from 'express';
import type { Request, Response } from 'express';
import type { AppConfig } from '../types/config.js';
import type { HarnessConfig } from '../types/agent.js';

export function createConfigRouter(config: AppConfig): Router {
  const router = Router();

  router.get('/config', (_req, res) => {
    // Strip gateway secrets before sending to client
    const { gateway: _gateway, ...safeConfig } = config;
    res.json(safeConfig);
  });

  // Runtime provider toggle — switches an agent between 'llm' and 'persistent-harness'
  // without requiring a server restart. Change persists until next restart.
  router.put('/agents/:agentKey/provider', (req: Request, res: Response) => {
    const agentKey = req.params.agentKey as string;
    const agent = config.agents[agentKey];
    if (!agent) {
      res.status(404).json({ error: `Agent '${agentKey}' not found` });
      return;
    }

    const { providerType, harnessConfig } = req.body as {
      providerType?: 'llm' | 'persistent-harness';
      harnessConfig?: HarnessConfig;
    };

    if (!providerType || !['llm', 'persistent-harness'].includes(providerType)) {
      res.status(400).json({ error: "providerType must be 'llm' or 'persistent-harness'" });
      return;
    }

    if (providerType === 'persistent-harness' && !harnessConfig?.adapter) {
      res.status(400).json({ error: "harnessConfig.adapter required when providerType is 'persistent-harness'" });
      return;
    }

    agent.providerType = providerType;
    if (harnessConfig) {
      agent.harnessConfig = harnessConfig;
    } else if (providerType === 'llm') {
      agent.harnessConfig = undefined;
    }

    res.json({ agentKey, providerType: agent.providerType, harnessConfig: agent.harnessConfig });
  });

  return router;
}
