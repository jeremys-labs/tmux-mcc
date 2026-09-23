import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {
  buildRuntimeHealthReport,
  type AgentRuntimeHealth,
  type HealthStatus,
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
  lastSchedulerFingerprint?: string;
  lastSchedulerSentAt?: string;
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

/**
 * Scheduler findings are fleet infrastructure, not an agent's runtime, so most of them
 * have no agent subject at all. This sentinel is deliberately not a valid agent key: it
 * can never equal a destination, so a fleet-level finding is always deliverable.
 *
 * `staleRecurring` is the exception and the reason the partition is not decorative here.
 * A stale job belongs to an agent, and the usual reason it is stale is that the agent's
 * runtime is unwell -- so reporting "your job has not run" into that agent's own channel
 * is the 2026-09-12 defect exactly: correct detection, delivered to the one place that
 * cannot act on it.
 */
export const SCHEDULER_FLEET_SUBJECT = '(scheduler)';

export interface SchedulerFinding {
  check: string;
  status: HealthStatus;
  /** Human-readable, and DELIBERATELY NOT part of incident identity -- see below. */
  detail: string;
  subject: string;
  /**
   * Stable incident identity beyond check+subject+severity.
   *
   * Empty for scalar checks. For set-valued checks it is the sorted affected job ids, so
   * a MEMBERSHIP change re-alerts while a re-measurement of the same set does not.
   *
   * This exists because `detail` carries live telemetry: schedulerTickPhase embeds the
   * current phaseMs, and a stale-heartbeat detail embeds an age in seconds that grows
   * every run. Fingerprinting the detail meant one continuing incident acquired a new
   * identity every five minutes and alerted every five minutes -- and my own dedupe test
   * codified that as intended behaviour, asserting 45000ms -> 61000ms should re-raise.
   * It is not a new incident; it is a new sample of the same one. (Eli, blocker on f477335.)
   */
  identity: string;
}

/**
 * Every scheduler check that is not `ok`.
 *
 * `unknown` is included and is NOT collapsed into the others. It means the monitor could
 * not tell, which is a different claim from "the scheduler is broken" and has a different
 * remedy; the status travels with the finding so a reader can separate them. Folding
 * `unknown` into `ok` would be the false-clean this row exists to prevent, and folding it
 * into `error` would page someone for a missing file.
 *
 * Until now nothing scheduled read `report.scheduler` at all -- the 5-minute monitor
 * consumed only `discordInboxDelivery` and the inbound reconcile, so a non-ok scheduler
 * check was computed every run and reached no one. (Eli's trace, PR #29.)
 */
export function findSchedulerFailures(report: RuntimeHealthReport): SchedulerFinding[] {
  const checks = report.scheduler.checks;
  const findings: SchedulerFinding[] = [];
  for (const [name, check] of Object.entries(checks)) {
    if (check.status === 'ok') continue;
    if (name === 'staleRecurring') continue; // fanned out per owning agent below
    findings.push({
      check: name,
      status: check.status,
      detail: check.detail,
      subject: SCHEDULER_FLEET_SUBJECT,
      identity: setValuedIdentity(name, report),
    });
  }
  // One finding per owning agent, so the partition can withhold the destination's own
  // stale jobs while still delivering everyone else's in the same run.
  if (checks.staleRecurring.status !== 'ok') {
    const byAgent = new Map<string, string[]>();
    const ids = new Map<string, string[]>();
    for (const job of report.scheduler.staleRecurringJobs) {
      const owner = job.agent ?? SCHEDULER_FLEET_SUBJECT;
      const list = byAgent.get(owner) ?? [];
      list.push(`${job.id} (${job.label}): ${job.reason}`);
      byAgent.set(owner, list);
      const idList = ids.get(owner) ?? [];
      idList.push(job.id);
      ids.set(owner, idList);
    }
    for (const [owner, jobs] of [...byAgent.entries()].sort()) {
      findings.push({
        check: 'staleRecurring',
        status: checks.staleRecurring.status,
        detail: `${jobs.length} stale recurring job(s): ${jobs.join('; ')}`,
        subject: owner,
        identity: ids.get(owner)?.slice().sort().join(',') ?? '',
      });
    }
  }
  return findings;
}

/**
 * Identity is check + subject + SEVERITY + stable ids. `detail` is excluded on purpose:
 * it carries a live measurement, so including it turns every re-measurement of one
 * continuing incident into a fresh alert every five minutes.
 *
 * What still re-alerts, which is the half that must not be lost: a severity TRANSITION
 * (warn -> error), a MEMBERSHIP change in a set-valued check, and a recovery followed by
 * a recurrence -- the last because an empty deliverable set clears the stored fingerprint.
 */
export function schedulerFailureFingerprint(findings: SchedulerFinding[]): string {
  return findings
    .map((f) => `${f.check}:${f.subject}:${f.status}:${f.identity}`)
    .sort()
    .join('|');
}

/** Sorted affected ids for the set-valued checks, so membership changes re-alert. */
function setValuedIdentity(check: string, report: RuntimeHealthReport): string {
  if (check === 'staleOneShots') {
    return report.scheduler.staleOneShotJobs.map((j) => j.id).sort().join(',');
  }
  if (check === 'jobTypes') {
    return report.scheduler.invalidTypeJobs.map((j) => j.id).sort().join(',');
  }
  return '';
}

export function formatSchedulerAlert(findings: SchedulerFinding[]): string {
  const lines = findings.map((f) => `- [${f.status}] ${f.check}${f.subject === SCHEDULER_FLEET_SUBJECT ? '' : ` (${f.subject})`}: ${f.detail}`);
  return [`runtime monitor scheduler check(s) not ok (${findings.length}):`, ...lines].join('\n');
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
 * PARTITION, DO NOT DROP. An alert batch carries many subjects, so blocking the whole batch
 * when one subject matches the destination loses every other agent's finding as collateral.
 * The invariant is per-FINDING -- "a finding about X must not reach X" -- so the split is
 * per-finding too: deliver everything that does not name the destination, withhold only what
 * does. Isla found this pre-merge; without it the guard's cost scales with the destination
 * agent's own message volume, and she is 625 of 1,369 breadcrumbs.
 */
export function partitionBySubject<T>(
  items: T[],
  destinationAgent: string,
  subjectOf: (item: T) => string,
): { deliverable: T[]; withheld: T[] } {
  const deliverable: T[] = [];
  const withheld: T[] = [];
  for (const item of items) {
    (subjectOf(item) === destinationAgent ? withheld : deliverable).push(item);
  }
  return { deliverable, withheld };
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

/**
 * Binds the dedup fingerprint to the DELIVERABLE set by construction, so the call site
 * cannot fingerprint the wrong one. My first version partitioned and fingerprinted as two
 * separate statements, and a red-verify showed the suite could not see them being put back
 * in the wrong order — the bug lived at the call site while the tests asserted properties of
 * the helpers. Making the invariant unrepresentable beats testing that nobody broke it.
 */
declare const DeliverableBrand: unique symbol;

/**
 * A set of findings that has passed the subject/destination partition. Only
 * `planAlertDispatch` can produce one, and only a `Deliverable` can become an alert
 * (see `alertFrom`). The invariant now lives in ONE place and the compiler objects if
 * anyone assembles an alert from another source -- which is what makes deleting the
 * redundant send-loop guard safe rather than one refactor away from wrong. (Eli's ask
 * after Isla found the dead branch.)
 */
export type Deliverable<T> = T[] & { readonly [DeliverableBrand]: true };

export function planAlertDispatch<T>(input: {
  items: T[];
  destinationAgent: string;
  subjectOf: (item: T) => string;
  fingerprintOf: (items: T[]) => string;
}): { deliverable: Deliverable<T>; withheld: T[]; fingerprint: string | null } {
  const { deliverable, withheld } = partitionBySubject(input.items, input.destinationAgent, input.subjectOf);
  return {
    deliverable: deliverable as Deliverable<T>,
    withheld,
    // null means "nothing was delivered, so record nothing as handled" -- the re-raise path.
    fingerprint: deliverable.length > 0 ? input.fingerprintOf(deliverable) : null,
  };
}

/**
 * The ONLY constructor of an alert entry. Takes a `Deliverable`, so an alert cannot be
 * built from an unpartitioned set without a compile error.
 */
export function alertFrom<T>(
  deliverable: Deliverable<T>,
  format: (items: T[]) => string,
  subjectOf: (item: T) => string,
): { text: string; subjects: string[] } {
  return { text: format(deliverable), subjects: deliverable.map(subjectOf) };
}

/** A repair must reach the same channel a failure would -- see the call site. */
export function formatInboundRecoveryNotice(
  entries: Array<{ key: string; agent: string; action: string; reason: string }>,
): string {
  const lines = entries.map((entry) => `- ${entry.agent} (${entry.action}): ${entry.reason}`);
  return [`runtime monitor self-healed ${entries.length} inbound miss(es):`, ...lines].join('\n');
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
  // Only ever populated via `alertFrom`, which accepts a branded `Deliverable` that only
  // `planAlertDispatch` can produce. THE PARTITION enforces "never a finding into its own
  // subject's channel" -- the send step does not check, and must not: a second enforcement
  // point there would `continue` past an already-stamped fingerprint. Assembling an alert
  // from an unpartitioned set is a compile error, not a convention.
  //
  // On 2026-09-12 `consumed_idle_no_reply` for a dead runtime was posted into that
  // runtime's own channel -- correct detection, delivered to the one place that could not
  // act on it. The detector was never broken; the destination was. (Isla's diagnosis.)
  const alerts: Array<{ text: string; subjects: string[] }> = [];
  // Findings whose subject IS the destination. They cannot go to that channel, so they are
  // reported as an explicit, loud gap rather than silently absent. Under the agreed chain
  // (operator -> Jeremy's DM -> log honestly) this list is what the second hop must carry;
  // until that hop exists these findings reach the log and nowhere else, and saying so is
  // the point.
  const withheldSubjects: string[] = [];

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

  // PARTITION BEFORE FINGERPRINTING. The dedup fingerprint must describe what was
  // DELIVERED, never what was merely queued. Fingerprinting the whole batch marks a
  // withheld finding as sent, and the next run suppresses it as a duplicate -- announced
  // once to stdout and then silent forever, which is worse than the 09-12 bug it replaces
  // because 09-12 at least kept shouting into the wrong channel. (Eli, must-fix on b49fd06.)
  // Withheld findings are deliberately absent from the fingerprint so they re-raise every
  // run until someone routes them: withholding means nobody has been told yet.
  const deliverySplit = planAlertDispatch({
    items: deliveryAlertFailures,
    destinationAgent: agent,
    subjectOf: (failure) => failure.agent,
    fingerprintOf: deliveryFailureFingerprint,
  });
  if (deliverySplit.withheld.length > 0) {
    withheldSubjects.push(...deliverySplit.withheld.map((failure) => failure.agent));
  }

  if (deliverySplit.deliverable.length === 0) {
    nextState.lastFingerprint = undefined;
    nextState.lastDeliveryFingerprint = undefined;
  } else {
    const fingerprint = deliverySplit.fingerprint as string;
    const previous = state.lastDeliveryFingerprint ?? state.lastFingerprint;
    if (previous === fingerprint && !hasFlag('--repeat')) {
      process.stdout.write(`runtime delivery monitor still failing; duplicate alert suppressed at ${report.generatedAtIso}\n`);
    } else {
      alerts.push(alertFrom(
        deliverySplit.deliverable,
        (agents) => formatDeliveryFailureAlert({ ...report, agents }),
        (failure) => failure.agent,
      ));
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
  const recoveredThisPass: Array<{ key: string; agent: string; action: string; reason: string }> = [];
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
      recoveredThisPass.push({ key: miss.key, agent: miss.agent, action: recovery.action, reason: recovery.reason });
    } else {
      inboundAlertMisses.push({ ...miss, detail: `${miss.detail}; forced recovery failed: ${recovery.reason}` });
    }
  }
  nextState.inboundRecoveryAttempts = recoveryAttempts;

  // A repair must reach the same channel a failure would. `alerts.length === 0` below
  // early-returns before any of this pass's stdout-only recovery lines are seen by anyone
  // but a log reader -- the only self-healing the team could see was the kind that did not
  // work. (Filed 2026-09-13, parked-bets-backlog.md "RECOVERY ROUTING".) Routed through the
  // same partition + alertFrom path as a failure, so it inherits the same "never into the
  // subject's own channel" guarantee for free.
  if (recoveredThisPass.length > 0) {
    const recoverySplit = planAlertDispatch({
      items: recoveredThisPass,
      destinationAgent: agent,
      subjectOf: (entry) => entry.agent,
      fingerprintOf: (entries) => entries.map((entry) => entry.key).sort().join(','),
    });
    if (recoverySplit.withheld.length > 0) {
      withheldSubjects.push(...recoverySplit.withheld.map((entry) => entry.agent));
    }
    if (recoverySplit.deliverable.length > 0) {
      alerts.push(alertFrom(
        recoverySplit.deliverable,
        formatInboundRecoveryNotice,
        (entry) => entry.agent,
      ));
    }
  }

  // Same ordering as the delivery path above, for the same reason: the fingerprint must
  // describe the DELIVERED set only, so a withheld finding re-raises every run.
  const inboundSplit = planAlertDispatch({
    items: inboundAlertMisses,
    destinationAgent: agent,
    subjectOf: (miss) => miss.agent,
    fingerprintOf: inboundReplyMissFingerprint,
  });
  if (inboundSplit.withheld.length > 0) {
    withheldSubjects.push(...inboundSplit.withheld.map((miss) => miss.agent));
  }

  if (inboundSplit.deliverable.length === 0) {
    nextState.lastInboundReplyFingerprint = undefined;
  } else {
    const fingerprint = inboundSplit.fingerprint as string;
    if (state.lastInboundReplyFingerprint === fingerprint && !hasFlag('--repeat')) {
      process.stdout.write(`inbound reply monitor still failing; duplicate alert suppressed at ${inboundResult.checkedAtIso}\n`);
    } else {
      alerts.push(alertFrom(
        inboundSplit.deliverable,
        (misses) => formatInboundReplyMissAlert({ ...inboundResult, misses }),
        (miss) => miss.agent,
      ));
      nextState.lastInboundReplyFingerprint = fingerprint;
      nextState.lastInboundReplySentAt = inboundResult.checkedAtIso;
    }
  }

  // SCHEDULER CHECKS. Same partition-then-fingerprint ordering as the two classes above,
  // for the same reason: the fingerprint must describe the DELIVERED set only, or a
  // withheld finding marks itself sent and is suppressed forever.
  const schedulerSplit = planAlertDispatch({
    items: findSchedulerFailures(report),
    destinationAgent: agent,
    subjectOf: (finding) => finding.subject,
    fingerprintOf: schedulerFailureFingerprint,
  });
  if (schedulerSplit.withheld.length > 0) {
    withheldSubjects.push(...schedulerSplit.withheld.map((finding) => finding.subject));
  }

  if (schedulerSplit.deliverable.length === 0) {
    nextState.lastSchedulerFingerprint = undefined;
  } else {
    const fingerprint = schedulerSplit.fingerprint as string;
    if (state.lastSchedulerFingerprint === fingerprint && !hasFlag('--repeat')) {
      process.stdout.write(`runtime scheduler monitor still failing; duplicate alert suppressed at ${report.generatedAtIso}\n`);
    } else {
      alerts.push(alertFrom(
        schedulerSplit.deliverable,
        formatSchedulerAlert,
        (finding) => finding.subject,
      ));
      nextState.lastSchedulerFingerprint = fingerprint;
      nextState.lastSchedulerSentAt = report.generatedAtIso;
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

  if (withheldSubjects.length > 0) {
    process.stdout.write(
      `runtime monitor WITHHELD ${withheldSubjects.length} finding(s) from destination ${agent}`
      + ` (delivered ${alerts.reduce((total, entry) => total + entry.subjects.length, 0)} finding(s) in the same pass):`
      + ` ${withholdReason({ destinationAgent: agent, subjects: withheldSubjects })}.`
      + ` NOT DELIVERED ANYWHERE, and NOT fingerprinted, so they re-raise every run until routed.\n`,
    );
  }

  if (alerts.length === 0) {
    process.stdout.write(`runtime delivery/reply monitor ok at ${report.generatedAtIso} — ${summary}\n`);
    if (!dryRun) writeMonitorState(statePath, nextState);
    return;
  }

  process.stdout.write(`${alerts.map((entry) => entry.text).join('\n\n')}\n`);
  process.stdout.write(`runtime delivery/reply monitor findings at ${report.generatedAtIso} — ${summary}\n`);
  if (!dryRun) {
    for (const entry of alerts) {
      // No subject check here, deliberately. `alerts` is built exclusively from the
      // deliverable partitions, which exclude the destination BY CONSTRUCTION. A second
      // enforcement point that cannot fire is not a backstop -- it is somewhere the rule
      // rots out of sync, and this one would have `continue`d PAST an already-stamped
      // fingerprint, holding Eli's permanent-suppression bug intact behind an upstream
      // guarantee. Latent defect + second mechanism that hides it = the safe-looking
      // change is the one that arms it. (Isla found this in re-review of 75d0bac.)
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
