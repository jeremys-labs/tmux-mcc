import fs from 'fs';
import path from 'path';
import { buildAnswerContext } from './answer-context.js';
import {
  runInboundRuntimeTurn,
  type RuntimeEventEmitter,
} from './runtime-events.js';
import type { OpenBrainRuntimeConfig } from './open-brain-runtime.js';

export interface BlueBubblesInboxEntry {
  id: string;
  chatId: string;
  sender: string;
  content: string;
  ts: string;
  policy: 'reply' | 'notify-only' | string;
  attachmentCount?: number;
}

export interface BlueBubblesInboxCursorState {
  lineCount: number;
}

export interface RuntimeBlueBubblesInboxDeliveryInput {
  agentKey: string;
  contentRoot: string;
  entry: BlueBubblesInboxEntry;
  events: RuntimeEventEmitter;
  submitPrompt: (prompt: string, entry: BlueBubblesInboxEntry) => Promise<void>;
  runtimeLogPath: string;
  openBrainConfig?: OpenBrainRuntimeConfig | null;
  targetAgentKey?: string;
}

export interface EnqueuePendingRuntimeBlueBubblesInboxInput extends Omit<RuntimeBlueBubblesInboxDeliveryInput, 'entry'> {
  deliveredIds: Set<string>;
  enqueue: (task: () => Promise<void>) => void;
}

function blueBubblesInboxDir(contentRoot: string): string {
  return process.env.BB_INBOX_DIR ?? path.join(contentRoot, 'bridge', 'bb-inbox');
}

function blueBubblesInboxPath(contentRoot: string): string {
  return path.join(blueBubblesInboxDir(contentRoot), 'incoming.jsonl');
}

function blueBubblesCursorPath(contentRoot: string, agentKey: string): string {
  return path.join(blueBubblesInboxDir(contentRoot), `${agentKey}.cursor.json`);
}

function appendRuntimeLog(runtimeLogPath: string, line: string): void {
  fs.appendFileSync(runtimeLogPath, `${new Date().toISOString()} ${line}\n`);
}

function readBlueBubblesInboxCursor(contentRoot: string, agentKey: string): BlueBubblesInboxCursorState {
  try {
    return JSON.parse(fs.readFileSync(blueBubblesCursorPath(contentRoot, agentKey), 'utf8')) as BlueBubblesInboxCursorState;
  } catch {
    return { lineCount: 0 };
  }
}

function writeBlueBubblesInboxCursor(contentRoot: string, agentKey: string, state: BlueBubblesInboxCursorState): void {
  fs.mkdirSync(blueBubblesInboxDir(contentRoot), { recursive: true });
  fs.writeFileSync(blueBubblesCursorPath(contentRoot, agentKey), JSON.stringify(state, null, 2));
}

function readBlueBubblesInboxLines(contentRoot: string): string[] {
  const filePath = blueBubblesInboxPath(contentRoot);
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function shouldPollBlueBubblesInbox(agentKey: string, targetAgentKey?: string): boolean {
  const target = targetAgentKey ?? process.env.BB_INBOX_AGENT_KEY ?? 'isla';
  return agentKey === target;
}

export function readPendingBlueBubblesInboxEntries(
  contentRoot: string,
  agentKey: string,
  targetAgentKey?: string
): BlueBubblesInboxEntry[] {
  if (!shouldPollBlueBubblesInbox(agentKey, targetAgentKey)) return [];
  const lines = readBlueBubblesInboxLines(contentRoot);
  const cursor = readBlueBubblesInboxCursor(contentRoot, agentKey);
  return lines.slice(cursor.lineCount).map((line) => JSON.parse(line) as BlueBubblesInboxEntry);
}

export function markBlueBubblesInboxEntryDelivered(
  contentRoot: string,
  agentKey: string,
  entry: BlueBubblesInboxEntry
): boolean {
  const lines = readBlueBubblesInboxLines(contentRoot);
  const cursor = readBlueBubblesInboxCursor(contentRoot, agentKey);
  const currentLine = lines[cursor.lineCount];
  if (!currentLine) return false;

  const current = JSON.parse(currentLine) as BlueBubblesInboxEntry;
  if (current.id !== entry.id) return false;

  writeBlueBubblesInboxCursor(contentRoot, agentKey, { lineCount: cursor.lineCount + 1 });
  return true;
}

export function formatBlueBubblesEntryForRuntime(entry: BlueBubblesInboxEntry): string {
  const content = entry.content.replace(/\s+/g, ' ').trim();
  const attrs = [
    'source="bluebubbles"',
    `chat_id="${entry.chatId}"`,
    `message_id="${entry.id}"`,
    `user="${entry.sender}"`,
    `ts="${entry.ts}"`,
    `policy="${entry.policy}"`,
  ];
  if (entry.attachmentCount && entry.attachmentCount > 0) {
    attrs.push(`attachment_count="${entry.attachmentCount}"`);
  }

  return [
    '[Messaging Gateway] BlueBubbles message routed for isla.',
    '',
    `<channel ${attrs.join(' ')}>${content}</channel>`,
    '',
    'Routing rule for this turn:',
    '- This message arrived from BlueBubbles via the Messaging Gateway.',
    '- Reply with the BlueBubbles reply tool when a text response is appropriate.',
    `- Use \`chat_id: "${entry.chatId}"\`.`,
    '- Do not answer only in the local relay session when the message needs an iMessage response.',
  ].join('\n');
}

export async function deliverRuntimeBlueBubblesInbox(input: RuntimeBlueBubblesInboxDeliveryInput): Promise<void> {
  const { agentKey, contentRoot, entry, events, submitPrompt, runtimeLogPath, openBrainConfig } = input;

  await runInboundRuntimeTurn({
    emit: events.emit,
    source: 'bluebubbles',
    messageId: entry.id,
    preparePrompt: async () => {
      const answerContext = await buildAnswerContext({
        agentKey,
        source: 'bluebubbles',
        text: entry.content,
        openBrainConfig,
      }).catch((error) => {
        appendRuntimeLog(runtimeLogPath, `answer-context bluebubbles error ${entry.id}: ${String(error)}`);
        return '';
      });

      if (answerContext) {
        appendRuntimeLog(runtimeLogPath, `built answer-context for bluebubbles ${entry.id}`);
      }

      return [answerContext, formatBlueBubblesEntryForRuntime(entry)].filter(Boolean).join('\n\n');
    },
    submitPrompt: (prompt) => submitPrompt(prompt, entry),
    acknowledgeDelivery: () => {
      const delivered = markBlueBubblesInboxEntryDelivered(contentRoot, agentKey, entry);
      if (!delivered) {
        throw new Error(`bluebubbles cursor ack failed for ${entry.id}`);
      }
      appendRuntimeLog(runtimeLogPath, `submitted bluebubbles ${entry.id}`);
    },
  });
}

export function enqueuePendingRuntimeBlueBubblesInbox(input: EnqueuePendingRuntimeBlueBubblesInboxInput): void {
  const pending = readPendingBlueBubblesInboxEntries(input.contentRoot, input.agentKey, input.targetAgentKey);
  for (const entry of pending) {
    if (input.deliveredIds.has(entry.id)) continue;
    input.deliveredIds.add(entry.id);
    input.enqueue(async () => {
      try {
        await deliverRuntimeBlueBubblesInbox({ ...input, entry });
      } catch (error) {
        input.deliveredIds.delete(entry.id);
        appendRuntimeLog(input.runtimeLogPath, `bluebubbles inject error ${entry.id}: ${String(error)}`);
      }
    });
  }
}
