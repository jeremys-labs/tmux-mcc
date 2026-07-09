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
  return lines.slice(cursor.lineCount).map((line) => JSON.parse(line) as CodexBridgeInboxEntry);
}

export function markInboxEntryDelivered(contentRoot: string, agentKey: string, entry: CodexBridgeInboxEntry): boolean {
  const filePath = inboxPath(contentRoot, agentKey);
  if (!fs.existsSync(filePath)) return false;

  const lines = fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const cursor = readInboxCursor(contentRoot, agentKey);
  const currentLine = lines[cursor.lineCount];
  if (!currentLine) return false;

  const current = JSON.parse(currentLine) as CodexBridgeInboxEntry;
  if (current.id !== entry.id) return false;

  writeInboxCursor(contentRoot, agentKey, { lineCount: cursor.lineCount + 1 });
  return true;
}

function resolveDiscordReplyTool(bindingName?: string): string {
  if (!bindingName) return 'Discord reply tool';
  const normalized = bindingName.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-');
  return `mcp__discord_${normalized}__.reply`;
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function formatInboxEntryForCodex(entry: CodexBridgeInboxEntry): string {
  const content = entry.content.replace(/\s+/g, ' ').trim();
  const attachmentLines = (entry.attachments ?? []).map((attachment, index) => {
    const details = [
      `filename="${escapeAttribute(attachment.filename)}"`,
      attachment.content_type ? `content_type="${escapeAttribute(attachment.content_type)}"` : null,
      typeof attachment.size === 'number' ? `size="${attachment.size}"` : null,
    ].filter(Boolean).join(' ');
    return `<attachment index="${index}" ${details} url="${escapeAttribute(attachment.url)}" />`;
  });
  const replyTool = resolveDiscordReplyTool(entry.bindingName);
  // Agents with a reply.sh wrapper in their agent dir (small local models that
  // fumble multi-flag CLIs) get a one-arg instruction instead of the npm form.
  const agentReplyScript = path.join('/Volumes/Repo-Drive/agents', entry.agentKey, 'reply.sh');
  const bridgeReplyCommand = fs.existsSync(agentReplyScript)
    ? 'write your reply as your normal final message — plain text, no tool calls; the harness delivers it to Discord automatically'
    : [
      'npm run discord:reply --workspace=@mcc-tmux/server --prefix /Volumes/Repo-Drive/src/mcc-tmux --',
      `--agent ${entry.agentKey}`,
      `--chat-id ${entry.channelId}`,
      '--text-file /absolute/path/to/reply.txt',
    ].join(' ');
  const attrs = [
    'source="discord"',
    `chat_id="${entry.channelId}"`,
    `message_id="${entry.id}"`,
    `user="${entry.author}"`,
    `ts="${entry.timestamp}"`,
  ];
  if (entry.authorId) attrs.push(`user_id="${entry.authorId}"`);
  if (entry.threadId) attrs.push(`thread_id="${entry.threadId}"`);
  if (entry.referencedMessageId) attrs.push(`referenced_message_id="${entry.referencedMessageId}"`);

  return [
    `[Messaging Gateway] Discord message routed for ${entry.agentKey}.`,
    '',
    `<channel ${attrs.join(' ')}>${content}</channel>`,
    ...(entry.referencedMessageContent ? [
      '',
      `<reply_reference message_id="${escapeAttribute(entry.referencedMessageId ?? '')}">${escapeAttribute(entry.referencedMessageContent.replace(/\s+/g, ' ').trim())}</reply_reference>`,
    ] : []),
    ...(attachmentLines.length > 0 ? ['', '<attachments>', ...attachmentLines, '</attachments>'] : []),
    '',
    fs.existsSync(agentReplyScript)
      ? `To reply: ${bridgeReplyCommand}. chat_id="${entry.channelId}".`
      : `Reply via \`${bridgeReplyCommand}\` (or \`--text\` for short shell-safe replies). chat_id="${entry.channelId}". Reply on Discord, not only the local session.`,
  ].join('\n');
}
