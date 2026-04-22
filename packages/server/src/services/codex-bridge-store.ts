import fs from 'fs';
import path from 'path';
import type { CodexBridgeInboxEntry } from '../types/codex-bridge.js';

interface BridgeState {
  lastSeenMessageIds: Record<string, string>;
}

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

function statePath(contentRoot: string): string {
  return path.join(contentRoot, 'bridge', 'state.json');
}

function inboxDir(contentRoot: string): string {
  return path.join(contentRoot, 'bridge', 'inbox');
}

export function readBridgeState(contentRoot: string): BridgeState {
  const filePath = statePath(contentRoot);
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as BridgeState;
  } catch {
    return { lastSeenMessageIds: {} };
  }
}

export function markSeen(contentRoot: string, subscriptionKey: string, messageId: string): void {
  ensureDir(path.dirname(statePath(contentRoot)));
  const current = readBridgeState(contentRoot);
  current.lastSeenMessageIds[subscriptionKey] = messageId;
  fs.writeFileSync(statePath(contentRoot), JSON.stringify(current, null, 2));
}

export function hasSeen(contentRoot: string, subscriptionKey: string, messageId: string): boolean {
  const current = readBridgeState(contentRoot);
  return current.lastSeenMessageIds[subscriptionKey] === messageId;
}

export function appendInboxEntry(contentRoot: string, entry: CodexBridgeInboxEntry): string {
  ensureDir(inboxDir(contentRoot));
  const filePath = path.join(inboxDir(contentRoot), `${entry.agentKey}.jsonl`);
  fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`);
  return filePath;
}
