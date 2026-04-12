import { Router } from 'express';
import type { GatewayClient } from '../gateway/client.js';

export function createHealthRouter(gateway: GatewayClient): Router {
  const router = Router();

  router.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      gateway: gateway.isConnected ? 'connected' : 'disconnected',
      timestamp: Date.now(),
    });
  });

  return router;
}
