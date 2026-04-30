import fs from 'fs';
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
      'startup restart current agent context',
      'active architecture decisions',
      'Discord routing',
      'agent memory OB1 runtime hooks',
      'current project state',
    ].join(' '),
    limit: 8,
    threshold: 0.2,
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

  await callOpenBrainTool(config, 'capture_agent_memory', {
    agent_id: config.agentId,
    scope: 'raw_capture',
    project: 'agent-runtime',
    audience: [config.agentId],
    authority: 'raw_capture',
    confidence: 'medium',
    source_type: 'claude_hook',
    source_ref: `claude-hook:${eventName}:${sessionId || Date.now()}`,
    content,
  });
}

function compactExcerpt(value: unknown, maxLength = 1200): string {
  let text = '';
  if (typeof value === 'string') {
    text = value;
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
  const candidates: Array<[string, unknown]> = [
    ['Command', toolInput.command],
    ['File content excerpt', toolInput.content],
    ['Old string excerpt', toolInput.old_string],
    ['New string excerpt', toolInput.new_string],
    ['Edit excerpt', toolInput.edits],
    ['Tool response excerpt', payload.tool_response],
    ['Tool output excerpt', payload.tool_output],
  ];

  for (const [label, value] of candidates) {
    const excerpt = compactExcerpt(value);
    if (excerpt) lines.push(`${label}: ${excerpt}`);
  }

  return lines;
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
