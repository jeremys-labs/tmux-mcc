#!/usr/bin/env node
import fs from 'fs';
import { createAgentMailStore, type AgentMailPriority, type AgentMailStatus, type AgentMailType } from '@agent-comms/mailbox';
import { callOpenBrainTool, resolveOpenBrainGroomingConfig } from './services/open-brain-runtime.js';

interface ParsedArgs {
  command: string;
  options: Map<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command = '', ...rest] = argv;
  const options = new Map<string, string | boolean>();
  for (let i = 0; i < rest.length; i += 1) {
    const current = rest[i];
    if (!current?.startsWith('--')) continue;
    const key = current.slice(2);
    const next = rest[i + 1];
    if (!next || next.startsWith('--')) {
      options.set(key, true);
      continue;
    }
    options.set(key, next);
    i += 1;
  }
  return { command, options };
}

function getRequired(options: Map<string, string | boolean>, key: string): string {
  const value = options.get(key);
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Missing required --${key}`);
  return value.trim();
}

function getOptional(options: Map<string, string | boolean>, key: string): string | undefined {
  const value = options.get(key);
  return typeof value === 'string' ? value.trim() : undefined;
}

function getBoolean(options: Map<string, string | boolean>, key: string): boolean {
  return options.get(key) === true;
}

function readBody(options: Map<string, string | boolean>): string {
  const body = getOptional(options, 'body');
  const bodyFile = getOptional(options, 'body-file');
  if (bodyFile) return fs.readFileSync(bodyFile, 'utf8');
  if (body) return body;
  throw new Error('Missing body content. Use --body or --body-file');
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function patchClosedMailRawCapture(messageId: string, closedAt: string | null): Promise<void> {
  const config = resolveOpenBrainGroomingConfig();
  if (!config || !closedAt) return;
  try {
    await callOpenBrainTool(config, 'patch_agent_raw_capture_metadata', {
      agent_id: config.agentId,
      source_ref: `agent-mail:${messageId}`,
      metadata_patch: {
        agent_mail_closed_at: closedAt,
        grooming_status: 'mail_closed',
        grooming_reviewed_at: closedAt,
        grooming_review_reason: 'agent-mail thread closed',
      },
    });
  } catch (error) {
    process.stderr.write(`[agent-mail] non-blocking Open Brain close cleanup failed for ${messageId}: ${String(error)}\n`);
  }
}

async function main(): Promise<void> {
  const { command, options } = parseArgs(process.argv.slice(2));
  const store = createAgentMailStore();
  try {
    switch (command) {
      case 'send':
        printJson(store.send({
          fromAgent: getRequired(options, 'from'),
          toAgent: getRequired(options, 'to'),
          type: getRequired(options, 'type') as AgentMailType,
          subject: getRequired(options, 'subject'),
          bodyMd: readBody(options),
          relatedProject: getOptional(options, 'project'),
          requiresResponse: getBoolean(options, 'requires-response'),
          priority: (getOptional(options, 'priority') as AgentMailPriority | undefined) ?? 'normal',
        }));
        break;
      case 'inbox':
        printJson(store.listInbox({
          agent: getRequired(options, 'agent'),
          status: getOptional(options, 'status') as AgentMailStatus | undefined,
        }));
        break;
      case 'ack':
        printJson(store.ackMessage(getRequired(options, 'agent'), getRequired(options, 'id')));
        break;
      case 'reply':
        printJson(store.reply({
          actorAgent: getRequired(options, 'agent'),
          messageId: getRequired(options, 'id'),
          bodyMd: readBody(options),
          subject: getOptional(options, 'subject'),
          requiresResponse: getBoolean(options, 'requires-response'),
          priority: getOptional(options, 'priority') as AgentMailPriority | undefined,
        }));
        break;
      case 'close': {
        const message = store.closeMessage(getRequired(options, 'agent'), getRequired(options, 'id'));
        await patchClosedMailRawCapture(message.id, message.closedAt);
        printJson(message);
        break;
      }
      case 'thread': {
        const messageId = getOptional(options, 'id');
        const correlationId = getOptional(options, 'correlation-id');
        if (!messageId && !correlationId) throw new Error('Missing --id or --correlation-id');
        const resolvedCorrelationId = correlationId ?? store.getMessage(messageId!)?.correlationId;
        if (!resolvedCorrelationId) throw new Error(`Message not found: ${messageId}`);
        printJson(store.getThread(resolvedCorrelationId));
        break;
      }
      default:
        throw new Error(`Unsupported command: ${command}`);
    }
  } finally {
    store.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
