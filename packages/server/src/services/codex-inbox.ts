import fs from 'fs';
import path from 'path';
import type { CodexBridgeInboxEntry } from '../types/codex-bridge.js';

export interface InboxCursorState {
  lineCount: number;
}

function runtimeStateDir(contentRoot: string): string {
  return path.join(contentRoot, 'bridge', 'runtime-state');
}

function inboxPath(contentRoot: string, agentKey: string): string {
  return path.join(contentRoot, 'bridge', 'inbox', `${agentKey}.jsonl`);
}

function cursorPath(contentRoot: string, agentKey: string): string {
  return path.join(runtimeStateDir(contentRoot), `${agentKey}.json`);
}

export function ensureRuntimeStateDir(contentRoot: string): void {
  fs.mkdirSync(runtimeStateDir(contentRoot), { recursive: true });
}

export function readInboxCursor(contentRoot: string, agentKey: string): InboxCursorState {
  try {
    return JSON.parse(fs.readFileSync(cursorPath(contentRoot, agentKey), 'utf8')) as InboxCursorState;
  } catch {
    return { lineCount: 0 };
  }
}

export function writeInboxCursor(contentRoot: string, agentKey: string, state: InboxCursorState): void {
  ensureRuntimeStateDir(contentRoot);
  fs.writeFileSync(cursorPath(contentRoot, agentKey), JSON.stringify(state, null, 2));
}

export function readPendingInboxEntries(contentRoot: string, agentKey: string): CodexBridgeInboxEntry[] {
  const filePath = inboxPath(contentRoot, agentKey);
  if (!fs.existsSync(filePath)) return [];

  const lines = fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const cursor = readInboxCursor(contentRoot, agentKey);
  const pending = lines.slice(cursor.lineCount).map((line) => JSON.parse(line) as CodexBridgeInboxEntry);
  if (pending.length > 0) {
    writeInboxCursor(contentRoot, agentKey, { lineCount: lines.length });
  }
  return pending;
}

export function formatInboxEntryForCodex(entry: CodexBridgeInboxEntry): string {
  const scope = entry.threadId
    ? `channel ${entry.channelId}, thread ${entry.threadId}`
    : `channel ${entry.channelId}`;
  const content = entry.content.replace(/\s+/g, ' ').trim();
  return `[Messaging Gateway] New Discord message from ${entry.author} in ${scope} at ${entry.timestamp}: ${content}`;
}
