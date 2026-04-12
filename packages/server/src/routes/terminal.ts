import { Router } from 'express';
import { listTmuxAgents } from '../services/tmux-relay.js';

export const terminalRouter = Router();

terminalRouter.get('/agents', (_req, res) => {
  const agents = listTmuxAgents();
  res.json({ agents });
});
