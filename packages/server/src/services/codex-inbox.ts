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

function resolveDiscordReplyTool(bindingName?: string): string {
  if (!bindingName) return 'Discord reply tool';
  const normalized = bindingName.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-');
  return `mcp__discord_${normalized}__.reply`;
}

export function formatInboxEntryForCodex(entry: CodexBridgeInboxEntry): string {
  const content = entry.content.replace(/\s+/g, ' ').trim();
  const replyTool = resolveDiscordReplyTool(entry.bindingName);
  const attrs = [
    'source="discord"',
    `chat_id="${entry.channelId}"`,
    `message_id="${entry.id}"`,
    `user="${entry.author}"`,
    `ts="${entry.timestamp}"`,
  ];
  if (entry.authorId) attrs.push(`user_id="${entry.authorId}"`);
  if (entry.threadId) attrs.push(`thread_id="${entry.threadId}"`);

  return [
    `[Messaging Gateway] Discord message routed for ${entry.agentKey}.`,
    '',
    `<channel ${attrs.join(' ')}>${content}</channel>`,
    '',
    'Routing rule for this turn:',
    '- This message arrived from Discord via the Messaging Gateway.',
    `- Reply on Discord using \`${replyTool}\`.`,
    `- Use \`chat_id: "${entry.channelId}"\`.`,
    '- Do not pass `reply_to` unless Jeremy explicitly asks for a threaded reply.',
    '- Do not answer only in the local relay session.',
  ].join('\n');
}
