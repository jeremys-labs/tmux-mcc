import { Router } from 'express';
import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import { WebSocketServer } from 'ws';
import { listTmuxAgents, TmuxRelay } from '../services/tmux-relay.js';

export const terminalRouter = Router();

terminalRouter.get('/agents', (_req, res) => {
  const agents = listTmuxAgents();
  res.json({ agents });
});

const relay = new TmuxRelay();
const wss = new WebSocketServer({ noServer: true });

// Pattern: /ws/terminal/:agentName (letters, numbers, hyphens, underscores)
const WS_PATH_PATTERN = /^\/ws\/terminal\/([a-z0-9_-]+)$/i;

export function handleUpgrade(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer
): void {
  const url = request.url ?? '';
  const match = url.match(WS_PATH_PATTERN);
  if (!match) {
    socket.destroy();
    return;
  }

  const agentName = match[1];

  wss.handleUpgrade(request, socket, head, (ws) => {
    const parseSize = (val: string | string[] | undefined, fallback: number): number => {
      const n = parseInt(String(val ?? ''), 10);
      return (!isNaN(n) && n > 0) ? n : fallback;
    };
    const cols = parseSize(request.headers['x-cols'], 220);
    const rows = parseSize(request.headers['x-rows'], 50);

    let sessionId: string;
    try {
      sessionId = relay.attach(agentName, ws, { cols, rows });
    } catch (err) {
      console.error(`[terminal] failed to attach to tmux window '${agentName}':`, err);
      ws.close(1011, 'Failed to attach to tmux session');
      return;
    }

    ws.on('message', (raw) => {
      const msg = raw.toString();
      try {
        const parsed = JSON.parse(msg);
        if (parsed.type === 'resize' && typeof parsed.cols === 'number' && typeof parsed.rows === 'number') {
          relay.resize(sessionId, parsed.cols, parsed.rows);
          return;
        }
      } catch {
        // not JSON — raw keystroke data, fall through to write
      }
      relay.write(sessionId, msg);
    });

    ws.on('close', () => relay.detach(sessionId));
    ws.on('error', () => relay.detach(sessionId));
  });
}
