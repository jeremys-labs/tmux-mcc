import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {
  buildRuntimeHealthReport,
  type AgentRuntimeHealth,
  type RuntimeHealthReport,
} from './services/runtime-health.js';
import {
  formatInboundReplyMissAlert,
  inboundReplyMissFingerprint,
  readInboundExpected,
  readOutboundSent,
  readReplyPolicy,
  reconcileInboundReplies,
  type SupervisorAgentStatus,
} from './services/inbound-reply-reconcile.js';
import { recoverInboundMiss } from './services/inbound-miss-recovery.js';

const DEFAULT_CHAT_ID = '1491979880747765810';
const DEFAULT_AGENT = 'eli';
const DEFAULT_STATE_PATH = '/Users/jeremylahners/.tmux-mcc/open-brain/runtime-health-monitor-state.json';
const DEFAULT_CONTENT_ROOT = '/Users/jeremylahners/.tmux-mcc';
const DEFAULT_SUPERVISOR_URL = 'http://127.0.0.1:4318';

interface MonitorState {
  // Legacy field from the delivery-only monitor. Read as a fallback, but write
  // separate fingerprints so sibling alarm classes cannot suppress each other.
  lastFingerprint?: string;
  lastSentAt?: string;
  lastDeliveryFingerprint?: string;
  lastDeliverySentAt?: string;
  lastInboundReplyFingerprint?: string;
  lastInboundReplySentAt?: string;
  inboundRecoveryAttempts?: Record<string, {
    attemptedAt: string;
    action: 'wake_queued' | 'replay_consumed' | 'none';
    agent: string;
    chatId: string;
  }>;
}

function readArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function readMonitorState(filePath: string): MonitorState {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as MonitorState;
  } catch {
    return {};
  }
}

function writeMonitorState(filePath: string, state: MonitorState): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`);
}

export function findDeliveryFailures(report: RuntimeHealthReport): AgentRuntimeHealth[] {
  return report.agents.filter((agent) => agent.discordInboxDelivery.status === 'error');
}

export function deliveryFailureFingerprint(failures: AgentRuntimeHealth[]): string {
  return failures
    .map((agent) => `${agent.agent}:${agent.discordInboxDelivery.detail}`)
    .sort()
    .join('|');
}

export function recoveryAttemptStillInGrace(input: {
  attemptedAt: string;
  checkedAt: string;
  graceMinutes: number;
}): boolean {
  const elapsed = Date.parse(input.checkedAt) - Date.parse(input.attemptedAt);
  return Number.isFinite(elapsed) && elapsed >= 0 && elapsed < input.graceMinutes * 60_000;
}

export function formatDeliveryFailureAlert(report: RuntimeHealthReport): string {
  const failures = findDeliveryFailures(report);
  const lines = [
    `Runtime delivery verification failed at ${report.generatedAtIso}.`,
    '',
    'Discord inbox messages are queued but have not crossed the runtime delivery cursor.',
    '',
    ...failures.slice(0, 10).map((agent) => `- ${agent.agent}: ${agent.discordInboxDelivery.detail}`),
  ];
  if (failures.length > 10) lines.push(`- ...and ${failures.length - 10} more agent(s).`);
  lines.push('');
  lines.push('Action: inspect the affected runtime pane/wrapper before claiming Discord delivery is healthy.');
  return lines.join('\n');
}

async function sendDiscordMessage(input: {
  agent: string;
  chatId: string;
  text: string;
  socketPath: string;
}): Promise<string> {
  const payload = JSON.stringify({
    agentKey: input.agent,
    chat_id: input.chatId,
    text: input.text,
  });
  return new Promise<string>((resolve, reject) => {
    const request = http.request({
      socketPath: input.socketPath,
      path: '/send',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        if ((response.statusCode ?? 500) < 200 || (response.statusCode ?? 500) >= 300) {
          reject(new Error(body));
          return;
        }
        resolve(body);
      });
    });
    request.on('error', reject);
    request.end(payload);
  });
}

async function readHttpJson<T>(url: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const request = http.get(url, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        if ((response.statusCode ?? 500) < 200 || (response.statusCode ?? 500) >= 300) {
          reject(new Error(`GET ${url} failed ${response.statusCode ?? 500}: ${body}`));
          return;
        }
        try {
          resolve(JSON.parse(body) as T);
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on('error', reject);
    request.setTimeout(3000, () => {
      request.destroy(new Error(`GET ${url} timed out`));
    });
  });
}

async function fetchSupervisorStatuses(supervisorUrl: string): Promise<SupervisorAgentStatus[]> {
  try {
    const url = new URL('/v1/agents', supervisorUrl).toString();
    const body = await readHttpJson<{ agents?: SupervisorAgentStatus[] }>(url);
    return Array.isArray(body.agents) ? body.agents : [];
  } catch (error) {
    process.stderr.write(`[runtime-health-monitor] supervisor liveness unavailable: ${String(error)}\n`);
    return [];
  }
}

async function main(): Promise<void> {
  const statePath = readArg('--state-path') ?? DEFAULT_STATE_PATH;
  const contentRoot = readArg('--content-root') ?? process.env.CONTENT_ROOT ?? DEFAULT_CONTENT_ROOT;
  const supervisorUrl = readArg('--supervisor-url') ?? process.env.AGENT_SUPERVISOR_URL ?? DEFAULT_SUPERVISOR_URL;
  const socketPath = readArg('--socket-path') ?? process.env.DISCORD_BRIDGE_SOCKET_PATH ?? '/tmp/agent-discord-bridge.sock';
  const chatId = readArg('--chat-id') ?? DEFAULT_CHAT_ID;
  const agent = readArg('--agent') ?? DEFAULT_AGENT;
  const dryRun = hasFlag('--dry-run');
  const report = await buildRuntimeHealthReport({
    includeOpenBrainSearch: false,
    contentRoot,
  });
  const failures = findDeliveryFailures(report);
  const state = readMonitorState(statePath);
  const nextState: MonitorState = { ...state };
  const alertMessages: string[] = [];

  if (failures.length === 0) {
    nextState.lastFingerprint = undefined;
    nextState.lastDeliveryFingerprint = undefined;
  } else {
    const fingerprint = deliveryFailureFingerprint(failures);
    const previous = state.lastDeliveryFingerprint ?? state.lastFingerprint;
    if (previous === fingerprint && !hasFlag('--repeat')) {
      process.stdout.write(`runtime delivery monitor still failing; duplicate alert suppressed at ${report.generatedAtIso}\n`);
    } else {
      alertMessages.push(formatDeliveryFailureAlert(report));
      nextState.lastDeliveryFingerprint = fingerprint;
      nextState.lastDeliverySentAt = report.generatedAtIso;
      nextState.lastFingerprint = fingerprint;
      nextState.lastSentAt = report.generatedAtIso;
    }
  }

  const supervisorStatuses = await fetchSupervisorStatuses(supervisorUrl);
  const inboundResult = reconcileInboundReplies({
    expected: readInboundExpected(contentRoot),
    outbound: readOutboundSent(contentRoot),
    policy: readReplyPolicy(contentRoot),
    supervisorStatuses,
    contentRoot,
    now: new Date(report.generatedAtIso),
  });
  const inboundAlertMisses = [] as typeof inboundResult.misses;
  const recoveryAttempts = { ...(state.inboundRecoveryAttempts ?? {}) };
  const outboundNow = readOutboundSent(contentRoot);
  for (const [key, attempt] of Object.entries(recoveryAttempts)) {
    if (outboundNow.some((sent) =>
      sent.agent === attempt.agent
      && sent.chat_id === attempt.chatId
      && sent.sent_at > attempt.attemptedAt)) delete recoveryAttempts[key];
  }

  for (const miss of inboundResult.misses) {
    const priorAttempt = recoveryAttempts[miss.key];
    if (priorAttempt) {
      if (recoveryAttemptStillInGrace({
        attemptedAt: priorAttempt.attemptedAt,
        checkedAt: inboundResult.checkedAtIso,
        graceMinutes: miss.graceMinutes,
      })) {
        process.stdout.write(`inbound recovery pending for ${miss.key}; alert suppressed\n`);
        continue;
      }
      inboundAlertMisses.push({
        ...miss,
        detail: `${miss.detail}; forced recovery ${priorAttempt.action} at ${priorAttempt.attemptedAt} did not produce a reply`,
      });
      continue;
    }

    if (dryRun) {
      inboundAlertMisses.push(miss);
      continue;
    }
    const recovery = recoverInboundMiss({
      miss,
      contentRoot,
      supervisorStatuses,
      dependencies: { now: new Date(inboundResult.checkedAtIso) },
    });
    process.stdout.write(`inbound recovery ${recovery.ok ? 'succeeded' : 'failed'} for ${miss.key}: ${recovery.reason}\n`);
    if (recovery.ok) {
      recoveryAttempts[miss.key] = {
        attemptedAt: inboundResult.checkedAtIso,
        action: recovery.action,
        agent: miss.agent,
        chatId: miss.chatId,
      };
    } else {
      inboundAlertMisses.push({ ...miss, detail: `${miss.detail}; forced recovery failed: ${recovery.reason}` });
    }
  }
  nextState.inboundRecoveryAttempts = recoveryAttempts;

  if (inboundAlertMisses.length === 0) {
    nextState.lastInboundReplyFingerprint = undefined;
  } else {
    const fingerprint = inboundReplyMissFingerprint(inboundAlertMisses);
    if (state.lastInboundReplyFingerprint === fingerprint && !hasFlag('--repeat')) {
      process.stdout.write(`inbound reply monitor still failing; duplicate alert suppressed at ${inboundResult.checkedAtIso}\n`);
    } else {
      alertMessages.push(formatInboundReplyMissAlert({ ...inboundResult, misses: inboundAlertMisses }));
      nextState.lastInboundReplyFingerprint = fingerprint;
      nextState.lastInboundReplySentAt = inboundResult.checkedAtIso;
    }
  }

  if (alertMessages.length === 0) {
    process.stdout.write(`runtime delivery/reply monitor ok at ${report.generatedAtIso}\n`);
    if (!dryRun) writeMonitorState(statePath, nextState);
    return;
  }

  process.stdout.write(`${alertMessages.join('\n\n')}\n`);
  if (!dryRun) {
    for (const message of alertMessages) {
      await sendDiscordMessage({ agent, chatId, text: message, socketPath });
    }
    writeMonitorState(statePath, nextState);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  });
}
