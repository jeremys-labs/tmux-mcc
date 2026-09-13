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
  deliveryRecoveryAttempts?: Record<string, {
    attemptedAt: string;
  }>;
  inboundRecoveryAttempts?: Record<string, {
    attemptedAt: string;
    action: 'wake_queued' | 'replay_consumed' | 'none';
    agent: string;
    chatId: string;
  }>;
}

interface DeliveryRecoveryAttempt {
  attemptedAt: string;
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

export async function recoverDeliveryFailuresBeforeAlert(input: {
  failures: AgentRuntimeHealth[];
  supervisorStatuses: SupervisorAgentStatus[];
  attempts: Record<string, DeliveryRecoveryAttempt>;
  checkedAt: string;
  graceMinutes: number;
  dryRun: boolean;
  restart: (agent: string) => Promise<void>;
}): Promise<{
  alerts: AgentRuntimeHealth[];
  attempts: Record<string, DeliveryRecoveryAttempt>;
}> {
  const attempts = { ...input.attempts };
  const failingAgents = new Set(input.failures.map((failure) => failure.agent));
  for (const agent of Object.keys(attempts)) {
    if (!failingAgents.has(agent)) delete attempts[agent];
  }
  const alerts: AgentRuntimeHealth[] = [];

  for (const failure of input.failures) {
    const prior = attempts[failure.agent];
    if (prior) {
      if (recoveryAttemptStillInGrace({
        attemptedAt: prior.attemptedAt,
        checkedAt: input.checkedAt,
        graceMinutes: input.graceMinutes,
      })) continue;
      alerts.push({
        ...failure,
        discordInboxDelivery: {
          ...failure.discordInboxDelivery,
          detail: `${failure.discordInboxDelivery.detail}; forced runtime restart at ${prior.attemptedAt} did not clear the queue`,
        },
      });
      continue;
    }

    const status = input.supervisorStatuses.find((row) => row.agent === failure.agent);
    if (status?.process?.status === 'running' && status.progress?.status === 'processing') {
      continue;
    }
    if (input.dryRun) {
      alerts.push(failure);
      continue;
    }
    try {
      await input.restart(failure.agent);
      attempts[failure.agent] = { attemptedAt: input.checkedAt };
    } catch (error) {
      alerts.push({
        ...failure,
        discordInboxDelivery: {
          ...failure.discordInboxDelivery,
          detail: `${failure.discordInboxDelivery.detail}; forced runtime restart failed: ${String(error)}`,
        },
      });
    }
  }
  return { alerts, attempts };
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

async function restartAgentForDelivery(supervisorUrl: string, agent: string, checkedAt: string): Promise<void> {
  const secret = process.env.AGENT_SUPERVISOR_COMMAND_SECRET;
  const response = await fetch(new URL('/v1/commands', supervisorUrl), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(secret ? { 'x-supervisor-secret': secret } : {}),
    },
    body: JSON.stringify({
      requestId: `runtime-delivery-recovery-${agent}-${checkedAt}`,
      operation: 'restart',
      agent,
      force: true,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`supervisor restart failed ${response.status}: ${body}`);
}

/**
 * A finding must never be delivered into a channel belonging to one of its own subjects.
 * 2026-09-12: `consumed_idle_no_reply` for a dead runtime was posted into that runtime's own
 * channel — correct detection, delivered to the one place that could not act on it.
 *
 * Exported because it is the load-bearing rule of this file. Left inline it would be
 * untestable, and an untestable guard is one nobody can prove still works.
 */
export function withholdReason(input: { destinationAgent: string; subjects: string[] }): string | null {
  const subjects = [...new Set(input.subjects)];
  if (!subjects.includes(input.destinationAgent)) return null;
  return `it is about ${subjects.join(', ')} and ${input.destinationAgent} is among its subjects,`
    + ` so that channel cannot be trusted to act on it`;
}

/**
 * A BARE `ok` IS NOT A RESULT. This monitor printed one every five minutes for months, and
 * three people read source code to establish what it covered — not because coverage was
 * wrong (it is fleet-wide) but because the output could not say so either way.
 * "Nothing to report" and "looked at almost nothing" are the same sentence without a
 * denominator.
 */
export function monitorSummary(input: {
  inboundFindings: number;
  expectedCount: number;
  matchedCount: number;
  deferredCount: number;
  skippedCount: number;
  deliveryFindings: number;
  agentsKnown: number;
}): string {
  return `inbound ${input.inboundFindings} finding(s) over ${input.expectedCount} expectation(s)`
    + ` (matched ${input.matchedCount}, deferred ${input.deferredCount}, skipped ${input.skippedCount});`
    + ` delivery ${input.deliveryFindings} finding(s) over ${input.agentsKnown} agent(s) known to the supervisor`;
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
  const supervisorStatuses = await fetchSupervisorStatuses(supervisorUrl);
  const state = readMonitorState(statePath);
  const nextState: MonitorState = { ...state };
  // Each alert carries the agents it is ABOUT, so the send step can refuse to deliver a
  // finding into the subject's own channel. On 2026-09-12 `consumed_idle_no_reply` for a
  // dead runtime was posted into that runtime's own channel -- correct detection, delivered
  // to the one place that could not act on it. The detector was never broken; the
  // destination was. (Isla's diagnosis; Marcus's build.)
  const alerts: Array<{ text: string; subjects: string[] }> = [];

  const deliveryRecovery = await recoverDeliveryFailuresBeforeAlert({
    failures,
    supervisorStatuses,
    attempts: state.deliveryRecoveryAttempts ?? {},
    checkedAt: report.generatedAtIso,
    graceMinutes: 10,
    dryRun,
    restart: (targetAgent) => restartAgentForDelivery(supervisorUrl, targetAgent, report.generatedAtIso),
  });
  nextState.deliveryRecoveryAttempts = deliveryRecovery.attempts;
  const deliveryAlertFailures = deliveryRecovery.alerts;

  if (deliveryAlertFailures.length === 0) {
    nextState.lastFingerprint = undefined;
    nextState.lastDeliveryFingerprint = undefined;
  } else {
    const fingerprint = deliveryFailureFingerprint(deliveryAlertFailures);
    const previous = state.lastDeliveryFingerprint ?? state.lastFingerprint;
    if (previous === fingerprint && !hasFlag('--repeat')) {
      process.stdout.write(`runtime delivery monitor still failing; duplicate alert suppressed at ${report.generatedAtIso}\n`);
    } else {
      alerts.push({
        text: formatDeliveryFailureAlert({ ...report, agents: deliveryAlertFailures }),
        subjects: deliveryAlertFailures.map((failure) => failure.agent),
      });
      nextState.lastDeliveryFingerprint = fingerprint;
      nextState.lastDeliverySentAt = report.generatedAtIso;
      nextState.lastFingerprint = fingerprint;
      nextState.lastSentAt = report.generatedAtIso;
    }
  }

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

  // queued_not_consumed is the delivery-cursor arm above. Keeping it out of
  // reply recovery prevents two independent actions and two competing alerts
  // for the same stuck inbox row.
  for (const miss of inboundResult.misses.filter((candidate) => candidate.failureClass !== 'queued_not_consumed')) {
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
      alerts.push({
        text: formatInboundReplyMissAlert({ ...inboundResult, misses: inboundAlertMisses }),
        subjects: inboundAlertMisses.map((miss) => miss.agent),
      });
      nextState.lastInboundReplyFingerprint = fingerprint;
      nextState.lastInboundReplySentAt = inboundResult.checkedAtIso;
    }
  }

  // A BARE `ok` IS NOT A RESULT. This line printed every 5 minutes for months and three
  // people read source code to find out what it covered -- not because coverage was wrong
  // (it is fleet-wide), but because the output could not say so either way. A check that
  // cannot state its denominator cannot be read, and "nothing to report" and "looked at
  // almost nothing" are the same sentence without one.
  const summary = monitorSummary({
    inboundFindings: inboundResult.misses.length,
    expectedCount: inboundResult.expectedCount,
    matchedCount: inboundResult.matchedCount,
    deferredCount: inboundResult.deferredCount,
    skippedCount: inboundResult.skippedCount,
    deliveryFindings: deliveryAlertFailures.length,
    agentsKnown: supervisorStatuses.length,
  });

  if (alerts.length === 0) {
    process.stdout.write(`runtime delivery/reply monitor ok at ${report.generatedAtIso} — ${summary}\n`);
    if (!dryRun) writeMonitorState(statePath, nextState);
    return;
  }

  process.stdout.write(`${alerts.map((entry) => entry.text).join('\n\n')}\n`);
  process.stdout.write(`runtime delivery/reply monitor findings at ${report.generatedAtIso} — ${summary}\n`);
  if (!dryRun) {
    for (const entry of alerts) {
      // NEVER the subject's own channel. Withholding is logged loudly rather than silently
      // skipped: an alert that is not sent and not reported is the false close this whole
      // change exists to stop -- the record would say the monitor ran and found nothing.
      const withheld = withholdReason({ destinationAgent: agent, subjects: entry.subjects });
      if (withheld) {
        process.stdout.write(
          `runtime monitor WITHHELD an alert from ${agent}: ${withheld}.`
          + ` NOT DELIVERED ANYWHERE. Route findings to an operator destination that is never a subject.\n`,
        );
        continue;
      }
      await sendDiscordMessage({ agent, chatId, text: entry.text, socketPath });
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
