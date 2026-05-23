import fs from 'node:fs';
import { resolveA2APaths } from '@agent-comms/a2a-client';
import { runA2APollerTick } from './services/runtime-a2a-poller.js';

const LOG_PATH = process.env.A2A_POLLER_LOG_PATH;
const TICK_INTERVAL_MS = 5_000;
const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;

async function tick(): Promise<void> {
  try {
    await runA2APollerTick({ logPath: LOG_PATH });
  } catch (err) {
    process.stderr.write(`[a2a-poller] tick error: ${String(err)}\n`);
  }
}

function heartbeat(): void {
  const paths = resolveA2APaths();
  fs.mkdirSync(paths.a2aDir, { recursive: true });
  fs.appendFileSync(paths.auditFile, `${JSON.stringify({ event: 'heartbeat', ts: new Date().toISOString() })}\n`);
}

tick().then(() => {
  setInterval(() => { void tick(); }, TICK_INTERVAL_MS);
  setInterval(heartbeat, HEARTBEAT_INTERVAL_MS);
});
