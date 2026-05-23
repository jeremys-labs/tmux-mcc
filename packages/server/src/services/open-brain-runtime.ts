import fs from 'fs';
import crypto from 'node:crypto';
import path from 'path';
import type { AgentMailMessage } from '@agent-comms/mailbox';
import type { CodexBridgeInboxEntry } from '../types/codex-bridge.js';

const DEFAULT_OPEN_BRAIN_ENV_PATH = '/Volumes/Repo-Drive/src/open-brain/credentials/ob1.env';
const DEFAULT_OPEN_BRAIN_ACCESS_KEY_PATH = '/Volumes/Repo-Drive/src/open-brain/credentials/mcp-access-key.txt';
const DEFAULT_AGENTS_ROOT = '/Volumes/Repo-Drive/agents';

export interface OpenBrainRuntimeConfig {
  agentId: string;
  endpointUrl: string;
  agentMemoryKey: string;
}

interface ToolCallResult {
  text: string;
}

function parseEnvFile(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
  return env;
}

function readEnvFile(filePath: string): Record<string, string> | null {
  try {
    return parseEnvFile(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function readTrimmedFile(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8').trim();
  } catch {
    return null;
  }
}

function resolveAgentMemoryEnvPath(agentKey: string): string {
  if (process.env.AGENT_MEMORY_ENV_PATH) return process.env.AGENT_MEMORY_ENV_PATH;
  const agentsRoot = process.env.AGENTS_ROOT ?? DEFAULT_AGENTS_ROOT;
  return path.join(agentsRoot, agentKey, '.open-brain', 'memory.env');
}

export function resolveOpenBrainRuntimeConfig(agentKey: string): OpenBrainRuntimeConfig | null {
  if (process.env.OPEN_BRAIN_RUNTIME_DISABLED === '1') return null;

  const openBrainEnvPath = process.env.OPEN_BRAIN_ENV_PATH ?? DEFAULT_OPEN_BRAIN_ENV_PATH;
  const accessKeyPath = process.env.OPEN_BRAIN_ACCESS_KEY_PATH ?? DEFAULT_OPEN_BRAIN_ACCESS_KEY_PATH;
  const openBrainEnv = readEnvFile(openBrainEnvPath);
  const agentEnv = readEnvFile(resolveAgentMemoryEnvPath(agentKey));
  if (!openBrainEnv || !agentEnv) return null;

  const projectUrl = openBrainEnv.SUPABASE_PROJECT_URL;
  const mcpAccessKey = process.env.OPEN_BRAIN_MCP_ACCESS_KEY ?? readTrimmedFile(accessKeyPath);
  const agentId = agentEnv.AGENT_MEMORY_AGENT_ID ?? agentKey;
  const agentMemoryKey = agentEnv.AGENT_MEMORY_KEY;
  if (!projectUrl || !mcpAccessKey || !agentId || !agentMemoryKey) return null;

  const url = new URL('/functions/v1/open-brain-mcp', projectUrl);
  url.searchParams.set('key', mcpAccessKey);
  url.searchParams.set('agent_key', agentMemoryKey);
  return { agentId, endpointUrl: url.toString(), agentMemoryKey };
}

export function resolveOpenBrainGroomingConfig(): OpenBrainRuntimeConfig | null {
  if (process.env.OPEN_BRAIN_RUNTIME_DISABLED === '1') return null;

  const openBrainEnvPath = process.env.OPEN_BRAIN_ENV_PATH ?? DEFAULT_OPEN_BRAIN_ENV_PATH;
  const accessKeyPath = process.env.OPEN_BRAIN_ACCESS_KEY_PATH ?? DEFAULT_OPEN_BRAIN_ACCESS_KEY_PATH;
  const openBrainEnv = readEnvFile(openBrainEnvPath);
  if (!openBrainEnv) return null;

  const projectUrl = openBrainEnv.SUPABASE_PROJECT_URL;
  const mcpAccessKey = process.env.OPEN_BRAIN_MCP_ACCESS_KEY ?? readTrimmedFile(accessKeyPath);
  const agentId = process.env.OPEN_BRAIN_GROOMING_AGENT_ID ?? 'grooming-bot';
  const agentMemoryKey = process.env.OPEN_BRAIN_GROOMING_AGENT_MEMORY_KEY
    ?? readEnvFile(resolveAgentMemoryEnvPath(agentId))?.AGENT_MEMORY_KEY;
  if (!projectUrl || !mcpAccessKey || !agentId || !agentMemoryKey) return null;

  const url = new URL('/functions/v1/open-brain-mcp', projectUrl);
  url.searchParams.set('key', mcpAccessKey);
  url.searchParams.set('agent_key', agentMemoryKey);
  return { agentId, endpointUrl: url.toString(), agentMemoryKey };
}

function parseMcpResponse(raw: string): ToolCallResult {
  const dataLines = raw
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trim())
    .filter(Boolean);

  const payloads = dataLines.length ? dataLines : [raw.trim()];
  for (const payload of payloads) {
    const parsed = JSON.parse(payload);
    if (parsed.error) {
      throw new Error(parsed.error.message ?? JSON.stringify(parsed.error));
    }
    if (parsed.result?.isError) {
      const errorText = Array.isArray(parsed.result.content)
        ? parsed.result.content
          .map((item: { text?: unknown }) => (typeof item?.text === 'string' ? item.text : ''))
          .filter(Boolean)
          .join('\n')
        : '';
      throw new Error(errorText || JSON.stringify(parsed.result));
    }
    const content = parsed.result?.content;
    if (Array.isArray(content)) {
      return {
        text: content
          .map((item) => (typeof item?.text === 'string' ? item.text : ''))
          .filter(Boolean)
          .join('\n'),
      };
    }
  }

  return { text: '' };
}

export async function callOpenBrainTool(
  config: OpenBrainRuntimeConfig,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  const response = await fetch(config.endpointUrl, {
    method: 'POST',
    headers: {
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
      'x-agent-memory-key': config.agentMemoryKey,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      method: 'tools/call',
      params: {
        name,
        arguments: {
          agent_key: config.agentMemoryKey,
          ...args,
        },
      },
    }),
  });

  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Open Brain ${name} failed: ${response.status} ${body}`);
  }
  return parseMcpResponse(body);
}

export async function searchStartupMemory(config: OpenBrainRuntimeConfig): Promise<string> {
  const result = await callOpenBrainTool(config, 'search_agent_memory', {
    agent_id: config.agentId,
    query: [
      `${config.agentId} current agent memory`,
      `${config.agentId} CLAUDE.md BOOTSTRAP memory/agents/${config.agentId}.md`,
      'startup restart current agent context',
      'role domain responsibilities current status active projects',
      'active architecture decisions',
      'Discord routing',
      'agent memory OB1 runtime hooks',
      'current project state',
    ].join(' '),
    limit: 8,
    threshold: 0.1,
  });
  return result.text;
}

export function formatStartupMemoryForCodex(agentKey: string, memoryText: string): string {
  const trimmed = memoryText.trim();
  if (!trimmed) return '';
  return [
    `[Open Brain Startup Recall] Governed memory retrieved for ${agentKey}.`,
    '',
    `<memory_context source="open-brain" agent_id="${agentKey}">`,
    trimmed,
    '</memory_context>',
    '',
    'Use this as startup context. For memory-relevant turns, search Open Brain before answering and capture durable conclusions through governed agent memory.',
  ].join('\n');
}

export function formatStartupMemoryForClaude(agentKey: string, memoryText: string): string {
  const trimmed = memoryText.trim();
  if (!trimmed) return '';
  return [
    `[Open Brain Startup Recall] Governed memory retrieved for ${agentKey}.`,
    '',
    `<memory_context source="open-brain" agent_id="${agentKey}">`,
    trimmed,
    '</memory_context>',
    '',
    'Use this as startup context. For memory-relevant turns, search Open Brain before answering and capture durable conclusions through governed agent memory.',
  ].join('\n');
}

export async function captureDiscordInboxEntry(
  config: OpenBrainRuntimeConfig,
  entry: CodexBridgeInboxEntry,
): Promise<void> {
  const content = entry.content.trim();
  if (!content) return;

  await callOpenBrainTool(config, 'capture_agent_memory', {
    agent_id: config.agentId,
    scope: 'raw_capture',
    project: 'agent-runtime',
    audience: [config.agentId],
    authority: 'raw_capture',
    confidence: 'medium',
    source_type: 'discord',
    source_ref: `discord:${entry.id}`,
    content,
  });
}

function stripChannelEnvelope(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(/^<channel\b[^>]*>([\s\S]*?)<\/channel>$/i);
  if (!match) return trimmed;
  return match[1].trim();
}

function stripInjectedContext(text: string): string {
  let stripped = text;
  stripped = stripped.replace(/<answer_context>[\s\S]*?<\/answer_context>/gi, ' ');
  stripped = stripped.replace(/<governed_memory>[\s\S]*?<\/governed_memory>/gi, ' ');
  stripped = stripped.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, ' ');
  stripped = stripped.replace(/\[Answer Context\][\s\S]*?(?=(?:<channel\b|<command-name>|$))/gi, ' ');
  return stripped.replace(/\s{3,}/g, '\n\n').trim();
}

function normalizeCapturedText(value: string): string {
  return stripChannelEnvelope(value);
}

function stablePromptSourceRef(sessionId: string, promptId: string, content: string): string {
  if (promptId) return `claude-prompt:${sessionId || 'unknown'}:${promptId}`;
  const digest = crypto.createHash('sha256').update(`${sessionId}\n${content}`).digest('hex').slice(0, 16);
  return `claude-prompt:${sessionId || 'unknown'}:sha256-${digest}`;
}

function resolveProjectFromCwd(payload: Record<string, unknown>): string {
  const cwd = typeof payload.cwd === 'string' ? payload.cwd : '';
  if (!cwd) return 'agent-runtime';

  const repoMatch = cwd.match(/^\/Volumes\/Repo-Drive\/src\/([^/]+)/);
  if (repoMatch) return repoMatch[1];

  const agentMatch = cwd.match(/^\/Volumes\/Repo-Drive\/agents\/([^/]+)/);
  if (agentMatch) return `agent:${agentMatch[1]}`;

  return 'agent-runtime';
}

const OWN_AGENT_CONFIDENCE = 0.7;

async function safeCapture(
  config: OpenBrainRuntimeConfig,
  args: Record<string, unknown>,
  label: string,
): Promise<void> {
  // Capture failures must never block the agent turn. Log to stderr and
  // swallow — the runtime hook is fire-and-forget from Claude's perspective.
  try {
    await callOpenBrainTool(config, 'capture_agent_memory', args);
  } catch (error) {
    process.stderr.write(`[open-brain-runtime] ${label} capture failed (non-blocking): ${String(error)}\n`);
  }
}

export async function captureClaudeHookEvent(
  config: OpenBrainRuntimeConfig,
  eventName: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const sessionId = typeof payload.session_id === 'string' ? payload.session_id : '';
  const toolInput = payload.tool_input && typeof payload.tool_input === 'object'
    ? payload.tool_input as Record<string, unknown>
    : {};
  const filePath = typeof toolInput.file_path === 'string'
    ? toolInput.file_path
    : typeof toolInput.notebook_path === 'string'
      ? toolInput.notebook_path
      : '';
  const evidence = formatClaudeHookEvidence(payload, toolInput);
  const content = [
    filePath ? `File: ${filePath}` : '',
    ...evidence,
  ].filter(Boolean).join('\n');
  if (!content.trim()) return;
  const discordReply = extractDiscordReplyCapture(payload, toolInput);

  // OB Phase 2 item 1 (Sprint 1 step 3): own-agent Discord replies are
  // private context by definition — write directly to private_agent/context
  // with numeric confidence rather than buffering in raw_capture for the
  // grooming round-trip. Other claude_hook telemetry (file edits, tool
  // metadata) keeps the legacy raw_capture path.
  if (discordReply) {
    await safeCapture(
      config,
      {
        agent_id: config.agentId,
        scope: 'private_agent',
        project: resolveProjectFromCwd(payload),
        audience: [config.agentId],
        authority: 'context',
        confidence: OWN_AGENT_CONFIDENCE,
        source_type: 'discord_reply',
        source_ref: discordReply.sourceRef,
        content,
      },
      'discord_reply',
    );
    return;
  }

  await safeCapture(
    config,
    {
      agent_id: config.agentId,
      scope: 'raw_capture',
      project: 'agent-runtime',
      audience: [config.agentId],
      authority: 'raw_capture',
      confidence: 'medium',
      source_type: 'claude_hook',
      source_ref: `claude-hook:${eventName}:${sessionId || Date.now()}`,
      content,
    },
    'claude_hook',
  );
}

export async function captureClaudePromptEvent(
  config: OpenBrainRuntimeConfig,
  promptText: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const cleaned = normalizeCapturedText(stripInjectedContext(normalizeCapturedText(promptText)));
  if (!cleaned) return;
  const sessionId = typeof payload.session_id === 'string' ? payload.session_id : '';
  const promptId = typeof payload.prompt_id === 'string'
    ? payload.prompt_id
    : typeof payload.promptId === 'string'
      ? payload.promptId
      : '';

  // OB Phase 2 item 1 (Sprint 1 step 3): user prompts to this agent ARE
  // this agent's private context. Skip the raw_capture buffer and write
  // directly to private_agent/context. source_ref is stable+idempotent
  // (sessionId + promptId) so retries don't create duplicates.
  await safeCapture(
    config,
    {
      agent_id: config.agentId,
      scope: 'private_agent',
      project: resolveProjectFromCwd(payload),
      audience: [config.agentId],
      authority: 'context',
      confidence: OWN_AGENT_CONFIDENCE,
      source_type: 'claude_prompt',
      source_ref: stablePromptSourceRef(sessionId, promptId, cleaned),
      content: cleaned,
    },
    'claude_prompt',
  );
}

function compactExcerpt(value: unknown, maxLength = 1200): string {
  let text = '';
  if (typeof value === 'string') {
    text = normalizeCapturedText(value);
  } else if (value !== undefined && value !== null) {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }

  text = text.replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

function formatClaudeHookEvidence(payload: Record<string, unknown>, toolInput: Record<string, unknown>): string[] {
  const lines: string[] = [];
  const invocation = payload.invocation && typeof payload.invocation === 'object'
    ? payload.invocation as Record<string, unknown>
    : {};
  const invocationArgs = invocation.arguments && typeof invocation.arguments === 'object'
    ? invocation.arguments as Record<string, unknown>
    : {};
  const candidates: Array<[string, unknown]> = [
    ['Tool name', payload.tool_name],
    ['Codex MCP server', invocation.server],
    ['Codex MCP tool', invocation.tool],
    ['Command', toolInput.command],
    ['Chat ID', toolInput.chat_id],
    ['Codex chat ID', invocationArgs.chat_id],
    ['Discord text excerpt', toolInput.text],
    ['Codex Discord text excerpt', invocationArgs.text],
    ['Message excerpt', toolInput.message],
    ['File content excerpt', toolInput.content],
    ['Old string excerpt', toolInput.old_string],
    ['New string excerpt', toolInput.new_string],
    ['Edit excerpt', toolInput.edits],
    ['Tool response excerpt', payload.tool_response],
    ['Tool output excerpt', payload.tool_output],
    ['Codex tool result excerpt', payload.result],
  ];

  for (const [label, value] of candidates) {
    const excerpt = compactExcerpt(value);
    if (excerpt) lines.push(`${label}: ${excerpt}`);
  }

  return lines;
}

function extractDiscordReplyCapture(
  payload: Record<string, unknown>,
  toolInput: Record<string, unknown>,
): { sourceRef: string } | null {
  const invocation = payload.invocation && typeof payload.invocation === 'object'
    ? payload.invocation as Record<string, unknown>
    : {};
  const toolName = typeof payload.tool_name === 'string' ? payload.tool_name : '';
  const codexServer = typeof invocation.server === 'string' ? invocation.server : '';
  const codexTool = typeof invocation.tool === 'string' ? invocation.tool : '';
  const isDiscordReply =
    toolName === 'mcp__plugin_discord_discord__reply' ||
    /^mcp__discord_.*__reply$/.test(toolName) ||
    (codexServer.startsWith('discord-') && codexTool === 'reply');
  if (!isDiscordReply) return null;

  const resultText = compactExcerpt(payload.result ?? payload.tool_response ?? payload.tool_output, 2000);
  const sentIdMatch = resultText.match(/\bsent \(id: ([0-9]+)\)/)
    ?? resultText.match(/\bids: ([0-9, ]+)/);
  const firstSentId = sentIdMatch?.[1]?.split(',')[0]?.trim();
  if (firstSentId) return { sourceRef: `discord-reply:${firstSentId}` };

  const chatId = typeof toolInput.chat_id === 'string'
    ? toolInput.chat_id
    : invocation.arguments && typeof invocation.arguments === 'object'
      ? (invocation.arguments as Record<string, unknown>).chat_id
      : '';
  return { sourceRef: `discord-reply:${typeof chatId === 'string' && chatId ? chatId : Date.now()}` };
}

export async function captureAgentMailMessage(
  config: OpenBrainRuntimeConfig,
  message: AgentMailMessage,
): Promise<void> {
  const content = [
    message.subject.trim() ? `Subject: ${message.subject.trim()}` : '',
    message.bodyMd.trim(),
  ].filter(Boolean).join('\n\n');
  if (!content.trim()) return;

  await callOpenBrainTool(config, 'capture_agent_memory', {
    agent_id: config.agentId,
    scope: 'raw_capture',
    project: message.relatedProject ?? 'agent-mail',
    audience: [config.agentId],
    authority: 'raw_capture',
    confidence: 'medium',
    source_type: 'agent_mail',
    source_ref: `agent-mail:${message.id}`,
    content,
  });
}
