import fs from 'fs';
import path from 'path';
import type { RuntimeEvent, RuntimeEventSink } from './runtime-events.js';

const DEFAULT_SHARED_DIR = '/Volumes/Repo-Drive/agents/SHARED';

export interface SharedActivitySinkOptions {
  sharedDir?: string;
  /** Test seam — defaults to `fs.appendFileSync`. */
  appendFileSync?: (file: string, data: string) => void;
}

/**
 * Returns a RuntimeEventSink that mirrors the SHARED activity / status logs
 * that the SessionEnd and Stop native hooks used to populate. Pi-owned so the
 * sink works identically across Claude, Codex, and any future runtime.
 *
 * Mapping:
 * - `afterAgentTurn`  -> append `{timestamp, agent, session_id}` to activity.jsonl
 * - `onRuntimeHealth` with `metadata.status === 'stopped'` -> append
 *   `{timestamp, agent, session_id, reason, transcript}` to status.jsonl
 *
 * `session_id` and `transcript` are populated when the event metadata carries
 * them; they're not required and default to empty strings (preserving the
 * native hook shape).
 */
export function createSharedActivitySink(
  options: SharedActivitySinkOptions = {},
): RuntimeEventSink {
  const sharedDir = options.sharedDir ?? DEFAULT_SHARED_DIR;
  const appendFile = options.appendFileSync ?? fs.appendFileSync;

  const activityPath = path.join(sharedDir, 'activity.jsonl');
  const statusPath = path.join(sharedDir, 'status.jsonl');

  return (event: RuntimeEvent) => {
    if (event.name === 'afterAgentTurn') {
      const row = {
        timestamp: event.ts,
        agent: event.agent,
        session_id: stringMeta(event, 'sessionId') ?? '',
      };
      appendFile(activityPath, `${JSON.stringify(row)}\n`);
      return;
    }

    if (event.name === 'onRuntimeHealth') {
      const status = stringMeta(event, 'status');
      if (status !== 'stopped') return;
      const row = {
        timestamp: event.ts,
        agent: event.agent,
        session_id: stringMeta(event, 'sessionId') ?? '',
        reason: stringMeta(event, 'reason') ?? 'wrapper-exit',
        transcript: stringMeta(event, 'transcript') ?? '',
      };
      appendFile(statusPath, `${JSON.stringify(row)}\n`);
    }
  };
}

function stringMeta(event: RuntimeEvent, key: string): string | undefined {
  const value = event.metadata?.[key];
  return typeof value === 'string' ? value : undefined;
}
