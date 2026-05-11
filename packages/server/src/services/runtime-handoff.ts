import fs from 'fs';
import path from 'path';
import { createAgentMailStore } from '@agent-comms/mailbox';
import { resolveContentRoot } from '../config.js';
import { readInboxCursor } from './codex-inbox.js';

export const RUNTIME_HANDOFF_SCHEMA_VERSION = 1;

export interface RuntimeHandoffV1 {
  schema_version: 1;
  agent: string;
  from_runtime: 'claude' | 'codex' | string;
  to_runtime: 'claude' | 'codex' | string;
  reason: string;
  ts: string;
  workspace: string;
  pending_mail_count: number;
  pending_inbox_count: number;
  next_step_notes: string;
  last_runtime_log_excerpt: string;
}

export interface BuildRuntimeHandoffInput {
  agent: string;
  fromRuntime: string;
  toRuntime: string;
  reason: string;
  workspace: string;
  contentRoot?: string;
  now?: Date;
  nextStepNotes?: string;
}

export interface PendingRuntimeHandoff {
  filePath: string;
  handoff: RuntimeHandoffV1;
  injectableText: string;
}

const MAX_REASON_LENGTH = 500;
const MAX_NOTES_LENGTH = 1200;
const MAX_LOG_EXCERPT_LENGTH = 1600;

export function runtimeHandoffPath(workspace: string): string {
  return path.join(workspace, '.runtime-handoff.md');
}

export function consumedRuntimeHandoffPath(workspace: string): string {
  return path.join(workspace, '.runtime-handoff.consumed.md');
}

function compact(value: string, maxLength: number): string {
  const text = value.replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{4,}/g, '\n\n\n').trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 3).trim()}...`;
}

function countPendingMail(agent: string): number {
  let store: ReturnType<typeof createAgentMailStore> | null = null;
  try {
    store = createAgentMailStore();
    return store.listInbox({ agent, status: 'new' }).length;
  } catch {
    return 0;
  } finally {
    store?.close();
  }
}

function countPendingCodexInbox(contentRoot: string, agent: string): number {
  const inboxPath = path.join(contentRoot, 'bridge', 'inbox', `${agent}.jsonl`);
  try {
    const cursor = readInboxCursor(contentRoot, agent);
    const lines = fs.readFileSync(inboxPath, 'utf8').split('\n').map((line) => line.trim()).filter(Boolean);
    return Math.max(0, lines.length - cursor.lineCount);
  } catch {
    return 0;
  }
}

function readLastRuntimeLogExcerpt(contentRoot: string, agent: string): string {
  const logPath = path.join(contentRoot, 'bridge', 'runtime-state', `${agent}.log`);
  try {
    const text = fs.readFileSync(logPath, 'utf8');
    return compact(text.slice(-MAX_LOG_EXCERPT_LENGTH), MAX_LOG_EXCERPT_LENGTH);
  } catch {
    return '';
  }
}

export function buildRuntimeHandoff(input: BuildRuntimeHandoffInput): RuntimeHandoffV1 {
  const contentRoot = input.contentRoot ?? resolveContentRoot();
  return {
    schema_version: RUNTIME_HANDOFF_SCHEMA_VERSION,
    agent: input.agent,
    from_runtime: input.fromRuntime,
    to_runtime: input.toRuntime,
    reason: compact(input.reason || 'runtime switch requested', MAX_REASON_LENGTH),
    ts: (input.now ?? new Date()).toISOString(),
    workspace: input.workspace,
    pending_mail_count: countPendingMail(input.agent),
    pending_inbox_count: countPendingCodexInbox(contentRoot, input.agent),
    next_step_notes: compact(input.nextStepNotes ?? '', MAX_NOTES_LENGTH),
    last_runtime_log_excerpt: readLastRuntimeLogExcerpt(contentRoot, input.agent),
  };
}

export function serializeRuntimeHandoff(handoff: RuntimeHandoffV1): string {
  return [
    '# Runtime Handoff',
    '',
    '```json',
    JSON.stringify(handoff, null, 2),
    '```',
    '',
  ].join('\n');
}

function parseRuntimeHandoff(text: string): RuntimeHandoffV1 | null {
  const trimmed = text.trim();
  const jsonText = trimmed.startsWith('{')
    ? trimmed
    : trimmed.match(/```json\s*([\s\S]*?)```/)?.[1]?.trim();
  if (!jsonText) return null;

  try {
    const parsed = JSON.parse(jsonText) as Partial<RuntimeHandoffV1>;
    if (parsed.schema_version !== RUNTIME_HANDOFF_SCHEMA_VERSION) return null;
    if (!parsed.agent || !parsed.from_runtime || !parsed.to_runtime || !parsed.ts || !parsed.workspace) return null;
    return {
      schema_version: RUNTIME_HANDOFF_SCHEMA_VERSION,
      agent: String(parsed.agent),
      from_runtime: String(parsed.from_runtime),
      to_runtime: String(parsed.to_runtime),
      reason: String(parsed.reason ?? ''),
      ts: String(parsed.ts),
      workspace: String(parsed.workspace),
      pending_mail_count: Number(parsed.pending_mail_count ?? 0),
      pending_inbox_count: Number(parsed.pending_inbox_count ?? 0),
      next_step_notes: String(parsed.next_step_notes ?? ''),
      last_runtime_log_excerpt: String(parsed.last_runtime_log_excerpt ?? ''),
    };
  } catch {
    return null;
  }
}

export function formatRuntimeHandoffForInjection(handoff: RuntimeHandoffV1): string {
  const lines = [
    `schema_version: ${handoff.schema_version}`,
    `agent: ${handoff.agent}`,
    `runtime: ${handoff.from_runtime} -> ${handoff.to_runtime}`,
    `reason: ${handoff.reason}`,
    `ts: ${handoff.ts}`,
    `workspace: ${handoff.workspace}`,
    `pending_mail_count: ${handoff.pending_mail_count}`,
    `pending_inbox_count: ${handoff.pending_inbox_count}`,
  ];
  if (handoff.next_step_notes) {
    lines.push('', 'next_step_notes:', handoff.next_step_notes);
  }
  if (handoff.last_runtime_log_excerpt) {
    lines.push('', 'last_runtime_log_excerpt:', handoff.last_runtime_log_excerpt);
  }
  return lines.join('\n');
}

export function writeRuntimeHandoff(workspace: string, handoff: RuntimeHandoffV1): string {
  fs.mkdirSync(workspace, { recursive: true });
  const filePath = runtimeHandoffPath(workspace);
  const tempPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tempPath, serializeRuntimeHandoff(handoff));
  fs.renameSync(tempPath, filePath);
  return filePath;
}

export function loadPendingRuntimeHandoff(workspace: string): PendingRuntimeHandoff | null {
  const filePath = runtimeHandoffPath(workspace);
  let text = '';
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  const handoff = parseRuntimeHandoff(text);
  if (!handoff) return null;
  return {
    filePath,
    handoff,
    injectableText: formatRuntimeHandoffForInjection(handoff),
  };
}

export function markRuntimeHandoffConsumed(workspace: string, consumedAt = new Date()): void {
  const filePath = runtimeHandoffPath(workspace);
  if (!fs.existsSync(filePath)) return;
  const consumedPath = consumedRuntimeHandoffPath(workspace);
  const text = fs.readFileSync(filePath, 'utf8');
  fs.writeFileSync(consumedPath, `${text.trim()}\n\nconsumed_at: ${consumedAt.toISOString()}\n`);
  fs.unlinkSync(filePath);
}
