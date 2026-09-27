import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
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
  // Set of withheld subjects last escalated to the principal. The findings themselves are
  // deliberately never fingerprinted (they must re-raise until routed); the ESCALATION is,
  // so a standing condition does not page a human every five minutes.
  lastWithheldFingerprint?: string;
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

/**
 * Detail to the operator over agent-mail. Deliberately NOT Discord: the monitor has no
 * channel that is not Jeremy's DM -- `start-runtime-health-monitor.sh` lists precedence
 * "1. isla 2. Jeremy's DM" and BOTH resolve to 1493425484036309092, so repointing the
 * flag could never have fixed this. (Isla's finding; I would have repointed it and
 * reported it fixed.)
 *
 * Failure is reported, never swallowed: a routing change whose failure mode is silence
 * would reproduce the defect it exists to fix, one layer along.
 */
async function sendOperatorMail(input: {
  to: string;
  subject: string;
  body: string;
  mailDir: string;
}): Promise<void> {
  const { execFile } = await import('node:child_process');
  const file = path.join(os.tmpdir(), `runtime-monitor-${Date.now()}.md`);
  fs.writeFileSync(file, `${input.body}\n`);
  try {
    await new Promise<void>((resolve, reject) => {
      execFile('agent-mail', [
        'send', '--from', 'marcus', '--to', input.to,
        '--type', 'note', '--subject', input.subject, '--body-file', file,
      ], { env: { ...process.env, AGENT_MAIL_DIR: input.mailDir } }, (error, _stdout, stderr) => {
        if (error) reject(new Error(stderr || error.message));
        else resolve();
      });
    });
  } finally {
    try { fs.unlinkSync(file); } catch { /* best effort */ }
  }
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
/**
 * WHERE each alarm class speaks. One table, exported, so the policy is testable and so a
 * new class cannot acquire a destination by sitting next to an existing send call.
 *
 * Before 2026-09-23 this decision did not exist: every class reached Discord because the
 * send loop only knew how to do that. The scheduler class's first live run put ~5,600
 * characters of stale-job UUIDs into the principal's DM.
 *
 * `inboundRecovery` mirrors `inbound` rather than being routed on its own merits: a repair
 * must reach the same channel its failure would. Routing the repair one way and the failure
 * the other would reopen the split that notice exists to close. It is asserted as an
 * EQUALITY in the suite, not as a literal, so it moves with `inbound` by construction.
 *
 * 2026-09-26 (dc-20260924-004): `delivery` and `inbound` moved to `operator`. 2026-09-23
 * routed ONLY `scheduler`, deliberately leaving the two older classes alone rather than
 * silently re-routing somebody else's alarm class. Jeremy's point closed that gap: those
 * classes are ALSO agent-addressed and ALSO exit through his DM. A delivery failure means an
 * agent runtime is not consuming its inbox, and an inbound miss means one did not reply --
 * the remedy for both is a restart or a `replay-inbound`, which is the operator's lane and
 * which this monitor already attempts itself before alerting. Jeremy cannot act on either;
 * he can only read them. The 2026-09-12 defect was a finding delivered to the one inbox that
 * could not act on it, and his DM is that inbox for this whole family of findings.
 *
 * WHICH LEAVES THE TABLE WITH NO `principal` MEMBER, AND THAT IS THE DESIGN, NOT AN
 * OVERSIGHT. Exactly one thing still reaches the principal, and it is not an alarm class:
 * the WITHHELD set -- findings whose subject IS the destination, i.e. the operator is the
 * broken party. That is the one case where Jeremy is the only actor left, and it is escalated
 * explicitly at the bottom of `main`. Before this change those findings reached stdout and
 * nowhere else; moving the two classes here without that hop would have widened a
 * zero-destination hole instead of closing one.
 */
export type AlertChannel = 'principal' | 'operator';
export type AlertClass = 'delivery' | 'inbound' | 'inboundRecovery' | 'scheduler';

export const ALERT_CHANNELS: Record<AlertClass, AlertChannel> = {
  delivery: 'operator',
  inbound: 'operator',
  inboundRecovery: 'operator',
  scheduler: 'operator',
};

export function channelFor(cls: AlertClass): AlertChannel {
  return ALERT_CHANNELS[cls];
}

export interface RoutedAlert {
  text: string;
  subjects: string[];
  channel: AlertChannel;
}

export async function dispatchRoutedAlert(
  alert: RoutedAlert,
  destinations: {
    principal: (entry: RoutedAlert) => Promise<void>;
    operator: (entry: RoutedAlert) => Promise<void>;
  },
): Promise<void> {
  await destinations[alert.channel](alert);
}

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

/**
 * A withheld finding, carried as a TYPED INCIDENT rather than a subject name.
 *
 * The first version of this aggregated `withheldSubjects: string[]`, and Eli rejected it on
 * two counts that are really one: a name is not a finding. Two distinct incidents about the
 * same agent -- an inbound miss and a stale recurring job -- collapsed into the single string
 * "isla", so (a) the second one could not change the fingerprint and never escalated at all,
 * and (b) the message that did go out could not say what either of them was. The comment
 * claiming "the detail stays in the operator mailbox" was false: operator alerts are built
 * only from the DELIVERABLE partitions, so a withheld finding reaches neither destination.
 *
 * `identity` vs `detail` is the distinction this file already paid for once (Eli's blocker on
 * f477335): `detail` carries live telemetry -- ages in seconds, phase milliseconds -- and
 * grows every run. It is for a human to read and MUST NOT enter the fingerprint, or one
 * continuing incident acquires a new identity every five minutes. `identity` is the stable
 * part: a miss key, a sorted job-id set, a check name.
 */
export interface WithheldIncident {
  alarmClass: AlertClass;
  subject: string;
  /** Stable. Class-specific. NEVER telemetry. Empty is legal for scalar checks. */
  identity: string;
  /** Human-readable, may carry live telemetry, deliberately NOT part of identity. */
  detail: string;
}

/**
 * What a human actually has to DO about each class, which is not the same question as where
 * the class is routed.
 *
 * The first version hardcoded "Restart <agent>" for every mix. Eli's third point: restarting
 * isla may clear an inbound miss, but it does not repair or explain a missed recurring job --
 * "the planner erased the class before choosing the action." A first-line action is only
 * worth the rule if it is TRUE for the set it is summarising.
 */
const WITHHELD_REMEDY: Record<AlertClass, 'restart' | 'jobs' | 'none'> = {
  delivery: 'restart',
  inbound: 'restart',
  // A SUCCESSFUL REPAIR IS NOT A FAILURE, and this entry was 'restart' until eli probed it.
  // `inboundRecovery` is the notice that the monitor FIXED an inbound miss itself, so telling
  // Jeremy to restart an agent that just self-healed is a false instruction in the first line
  // of the one message that is supposed to be nothing but a true instruction.
  //
  // 'none' means SUPPRESSED FROM THE PRINCIPAL: `planWithheldEscalation` sends nothing for a
  // set that is entirely self-repair, because acceptance item (3) is "states the required
  // action in its first line OR IS SUPPRESSED" and there is no action here. The notices are
  // still WRITTEN -- to the monitor log, which is where the team reads self-healing; the
  // 2026-09-13 defect was invisible repair, not unreported repair.
  //
  // This comment said the opposite ("it still has to be SENT ... not suppress it") for one
  // commit, because I changed the implementation from rewording to suppression and left the
  // prose describing the version I had abandoned. eli caught it. That is the third instance in
  // this row of a sentence asserting behaviour the code no longer had.
  inboundRecovery: 'none',
  scheduler: 'jobs',
};

/** At most this many incident lines in the principal message; the rest are counted. */
const WITHHELD_DETAIL_LINES = 6;
/**
 * Cap on the WHOLE incident line, not on `detail` alone.
 *
 * It capped only `detail` until eli probed it, and `identity` is not bounded either: a
 * scheduler identity is a sorted job-id set, and hank's staleRecurring finding already carries
 * five UUIDs. I had a two-UUID identity in front of me in my own dry-run and did not follow
 * the growth path. Truncating one field of a line built from two is not bounding the line.
 */
const WITHHELD_LINE_CHARS = 200;

export function withheldFirstLineAction(input: {
  destinationAgent: string;
  incidents: WithheldIncident[];
}): string {
  const remedies = new Set(input.incidents.map((incident) => WITHHELD_REMEDY[incident.alarmClass]));
  const count = input.incidents.length;
  const tail = `${count} monitor finding(s) about ${input.destinationAgent} cannot be delivered to it.`;
  const restart = remedies.has('restart');
  const jobs = remedies.has('jobs');
  if (restart && jobs) {
    return `Restart ${input.destinationAgent} and check its scheduled jobs — ${tail}`;
  }
  if (jobs) return `Check ${input.destinationAgent}'s scheduled jobs — ${tail}`;
  if (restart) return `Restart ${input.destinationAgent} — ${tail}`;
  // Only self-repair notices. `planWithheldEscalation` SUPPRESSES this set rather than sending
  // it (acceptance item 3 is "states the required action in its first line OR IS SUPPRESSED",
  // and a successful self-heal has no action for Jeremy). This branch exists so the function is
  // still truthful when called directly, and so a future caller cannot get "Restart" here.
  return `No action needed — ${input.destinationAgent} self-healed ${count} finding(s) it could not report to itself.`;
}

/**
 * Does this withheld set need a human at all?
 *
 * False when every incident is a SUCCESSFUL self-repair. Those stay in the monitor log -- the
 * 2026-09-13 defect was invisible self-healing, and the log is where the team sees it -- but
 * they do not page the principal, because there is nothing for him to do. Eli's blocker: my
 * table classified success as a restart failure, so a lone recovery notice opened with
 * "Restart isla" after the replay had already worked.
 */
export function withheldNeedsPrincipal(incidents: WithheldIncident[]): boolean {
  return incidents.some((incident) => WITHHELD_REMEDY[incident.alarmClass] !== 'none');
}

/**
 * THE ONLY THING THAT STILL REACHES THE PRINCIPAL, and the reason the table above has no
 * `principal` member. A withheld finding is one whose SUBJECT is the destination -- the
 * operator is the broken party -- so there is no agent left who can act on it and Jeremy is
 * the last actor in the chain.
 *
 * FIRST LINE IS THE ACTION, NOT THE DIAGNOSIS, and it now derives from the classes actually
 * present rather than assuming a restart fixes everything. The body carries bounded per-
 * incident detail: this is the ONLY place a withheld finding is ever stated, so "see the log"
 * alone would be the information loss Eli rejected, and an unbounded dump would be the 09-23
 * incident. Six lines, 160 chars each, then a count.
 */
export function formatWithheldEscalation(input: {
  destinationAgent: string;
  incidents: WithheldIncident[];
  /**
   * How many findings in this pass are ADDRESSED TO THE OPERATOR rather than withheld.
   * REQUIRED, and not defaulted.
   *
   * Two corrections live in this one field. It began as a flat "Every other finding this pass
   * was delivered normally", and the first live dry-run printed that in a pass where the
   * scheduler alert had been duplicate-suppressed and nothing else went anywhere -- an
   * unfalsifiable reassurance, false on its first real run, the `|| echo "<good news>"` shape
   * in prose. It then became `deliveredCount`, which eli rejected for a subtler reason: the
   * number is computed from alerts QUEUED IN MEMORY, before any transport runs, so under
   * `--dry-run` nothing is sent and the word "delivered" was still a claim of completed work.
   *
   * ADDRESSING is a fact at assembly time; DELIVERY is not. The wording now reports only what
   * the count can actually support, which is also the thing Jeremy needs from it: which
   * findings are his and which are not.
   */
  operatorAddressedCount: number;
}): string {
  const shown = input.incidents.slice(0, WITHHELD_DETAIL_LINES);
  const hidden = input.incidents.length - shown.length;
  const lines = [
    withheldFirstLineAction(input),
    `Routing them to ${input.destinationAgent} would report a broken runtime to itself, so this`
    + ' is the only message that carries them — they are absent from the operator mailbox by'
    + ' construction. Summarised below; the full set is in the monitor log.',
    ...shown.map((incident) => {
      const id = incident.identity ? ` ${incident.identity}` : '';
      const line = `- [${incident.alarmClass}]${id}: ${incident.detail}`;
      // Bound the assembled LINE. Both `identity` and `detail` grow with the finding, so
      // capping either one alone leaves the other free to carry the message away.
      return line.length > WITHHELD_LINE_CHARS ? `${line.slice(0, WITHHELD_LINE_CHARS - 1)}…` : line;
    }),
  ];
  if (hidden > 0) lines.push(`- …and ${hidden} more withheld finding(s); full set in the monitor log.`);
  if (input.operatorAddressedCount > 0) {
    lines.push(`The other ${input.operatorAddressedCount} finding(s) this pass are addressed to the operator, not to you.`);
  }
  return lines.join('\n');
}

/**
 * Stable across runs for the same set of withheld INCIDENTS, so a standing condition is
 * escalated once rather than every five minutes -- and a NEW incident for an
 * already-withheld subject still changes it. The subject-set version could not do the second
 * thing, which is Eli's blocker 1: a new stale-job finding joining an existing inbound miss
 * for isla left the fingerprint at "isla" and escalated nothing.
 *
 * Identity only. `detail` is excluded on purpose -- see WithheldIncident.
 */
export function withheldEscalationFingerprint(incidents: WithheldIncident[]): string {
  return [...new Set(incidents.map(
    (incident) => `${incident.alarmClass}:${incident.subject}:${incident.identity}`,
  ))].sort().join('|');
}

/**
 * What `planWithheldEscalation` DECIDED. One value, produced in one place, and the only input
 * that tells the log header what to claim.
 *
 * - `escalating`       an alert exists and is about to be dispatched
 * - `self_repair_only` every incident is a successful self-heal; nothing needs a human
 * - `unchanged`        a human has already been told about this exact incident set
 */
export type WithheldOutcome = 'escalating' | 'self_repair_only' | 'unchanged';

/**
 * The log header for a withheld set, as a function, because it makes a claim that is only true
 * on ONE of the planner's three outcomes.
 *
 * It said "The principal escalation below is the ONLY message that carries them"
 * unconditionally, printed before the planner had decided whether an escalation existed. For a
 * self-repair-only set there is none, and the very next line said "no principal escalation
 * needed". Two contradictory claims, consecutively. (eli.)
 *
 * IT TAKES THE PLANNER'S `outcome`, NOT A BOOLEAN IT COULD HAVE COMPUTED ITSELF. My first
 * attempt passed a `needsPrincipal` flag and the comment claimed it was "computed once and
 * handed to both, so they cannot disagree" -- while `planWithheldEscalation` went on calling
 * `withheldNeedsPrincipal` again internally. TWO DECISIONS, and a comment asserting one. eli
 * traced it: main at one line, the planner at another, the flag never an input or output of the
 * plan. They agreed only because both called the same pure predicate over the same set.
 *
 * ⚡ THE FIX FOR "PROSE OUTRAN EXECUTION" WAS ITSELF PROSE THAT OUTRAN EXECUTION, in the
 * fifth round of a review about exactly that. The lesson is not "write more careful comments":
 * it is that a claim of single-sourcing has to be STRUCTURAL. There is now no boolean to
 * disagree about, because the header cannot reach the predicate -- it can only read the
 * decision the planner already made.
 */
export function formatWithheldLogHeader(input: {
  destinationAgent: string;
  withheldCount: number;
  operatorAddressedCount: number;
  reason: string;
  outcome: WithheldOutcome;
}): string {
  const head = `runtime monitor WITHHELD ${input.withheldCount} finding(s) from destination ${input.destinationAgent}`
    + ` (${input.operatorAddressedCount} finding(s) this pass addressed to the operator):`
    + ` ${input.reason}.`;
  if (input.outcome === 'escalating') {
    return `${head} The principal escalation below is the ONLY message that carries them —`
      + ' they are absent from the operator mailbox by construction.';
  }
  if (input.outcome === 'self_repair_only') {
    return `${head} Self-repair only: nothing here needs a human, so no principal escalation is`
      + ' sent. These lines are the only record of them.';
  }
  return `${head} The principal was already told about this exact set, so no escalation is`
    + ' repeated. These lines are the current record of them.';
}

/**
 * THE WIRING, AS A FUNCTION, so the suite can prove a withheld finding actually acquires a
 * destination instead of a comment claiming it does. The escalation is the only alert built
 * outside the `Deliverable` path, which means the type system is NOT holding this invariant
 * up -- and an invariant nothing enforces is one refactor from gone.
 *
 * Returns the alert to send (or null when suppressed) plus the fingerprint to record. The
 * fingerprint is returned on BOTH branches on purpose: a suppressed escalation must still
 * re-stamp, or the next pass sees no prior fingerprint and sends again.
 */
export function planWithheldEscalation(input: {
  incidents: WithheldIncident[];
  destinationAgent: string;
  operatorAddressedCount: number;
  lastFingerprint?: string;
  repeat?: boolean;
}): { alert: RoutedAlert | null; fingerprint: string | undefined; outcome: WithheldOutcome } {
  if (input.incidents.length === 0) return { alert: null, fingerprint: undefined, outcome: 'unchanged' };
  // Every incident is a successful self-repair: nothing for the principal to do, so nothing is
  // sent and nothing is stamped. They remain in the monitor log, which is where the team reads
  // self-healing. Suppression is the other arm of this row's own message rule.
  //
  // THIS IS THE ONLY PLACE THE QUESTION IS ASKED. The log header reads the `outcome` returned
  // below; it has no boolean of its own and no access to the predicate.
  if (!withheldNeedsPrincipal(input.incidents)) {
    return { alert: null, fingerprint: undefined, outcome: 'self_repair_only' };
  }
  const fingerprint = withheldEscalationFingerprint(input.incidents);
  if (input.lastFingerprint === fingerprint && !input.repeat) {
    return { alert: null, fingerprint, outcome: 'unchanged' };
  }
  return {
    outcome: 'escalating',
    alert: {
      text: formatWithheldEscalation({
        destinationAgent: input.destinationAgent,
        incidents: input.incidents,
        operatorAddressedCount: input.operatorAddressedCount,
      }),
      subjects: [...new Set(input.incidents.map((incident) => incident.subject))].sort(),
      // OPERATOR, not principal. 2026-09-27: Jeremy was paged three times in one day --
      // 00:18:33Z, 13:24:51Z, 14:50:34Z -- with "Restart isla and check its scheduled jobs"
      // while isla was actively answering him in that same channel. The escalation asked the
      // PRINCIPAL to perform an operational recovery on an agent that was demonstrably fine.
      //
      // On 09-24 Jeremy asked "You have agent-mail, why are jobs sending to your discord at
      // all?" and we shipped ALERT_CHANNELS so scheduler alerts route to mail. THIS PATH WENT
      // AROUND IT, because it is specifically the path for findings that cannot be routed
      // normally -- so the exception to the routing fix inherited none of the routing fix.
      // (Isla's phrasing, and it is the whole defect in one sentence.)
      //
      // Mailing the operator is sound even when the operator IS a subject, which is today's
      // case: the 2026-09-12 defect was a finding delivered into a DEAD RUNTIME'S OWN UI,
      // which is unreadable by construction. agent-mail is DURABLE -- a dead agent reads it on
      // wake -- so subject-as-recipient here degrades to "late", not "never".
      //
      // NOT YET BUILT, and it is the remaining gap: principal as LAST resort when the operator
      // is unreachable. Jeremy should be the hop after every agent is unreachable, not the
      // second hop. sendOperatorMail already reports its failures rather than swallowing them,
      // so a failed escalation is visible today; it is not yet re-routed.
      channel: 'operator',
    },
    fingerprint,
  };
}

async function main(): Promise<void> {
  const statePath = readArg('--state-path') ?? DEFAULT_STATE_PATH;
  const contentRoot = readArg('--content-root') ?? process.env.CONTENT_ROOT ?? DEFAULT_CONTENT_ROOT;
  const supervisorUrl = readArg('--supervisor-url') ?? process.env.AGENT_SUPERVISOR_URL ?? DEFAULT_SUPERVISOR_URL;
  const socketPath = readArg('--socket-path') ?? process.env.DISCORD_BRIDGE_SOCKET_PATH ?? '/tmp/agent-discord-bridge.sock';
  const chatId = readArg('--chat-id') ?? DEFAULT_CHAT_ID;
  const agent = readArg('--agent') ?? DEFAULT_AGENT;
  const dryRun = hasFlag('--dry-run');
  // Operator destination is configurable but defaults to the agent who owns fleet
  // infrastructure. Unlike the Discord flag, this one CAN point somewhere that is not
  // Jeremy's DM, which is the whole point of the change.
  const operatorAgent = readArg('--operator-agent') ?? 'isla';
  const mailDir = readArg('--mail-dir') ?? process.env.AGENT_MAIL_DIR ?? '/Volumes/Repo-Drive/agents/SHARED/agent-mail';
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
  // WHERE a finding goes is now a declared property of the finding, not a property of
  // which send call happened to be nearest. 2026-09-23: the scheduler class's first live
  // run put ~5,600 characters of stale-job UUIDs into Jeremy's DM and he told us so --
  // "I'm not reading all that." Operator diagnostics and principal escalation had the same
  // destination because they had the same code path.
  //
  // `operator` -> agent-mail (full detail, durable, addressed to someone whose lane it is)
  // `principal` -> Discord (few lines, only where a human decision is actually needed)
  //
  // 2026-09-26: delivery and inbound moved to `operator` too, so NO alarm class points at the
  // principal any more. The principal's only message is the withheld escalation below -- the
  // one case where the operator is the broken party and a human is the last actor left.
  const alerts: RoutedAlert[] = [];
  // Findings whose subject IS the destination. They cannot go to that channel, so they are
  // reported as an explicit, loud gap rather than silently absent. Under the agreed chain
  // (operator -> Jeremy's DM -> log honestly) this list is what the second hop must carry;
  // until that hop exists these findings reach the log and nowhere else, and saying so is
  // the point.
  // TYPED INCIDENTS, not names. A name cannot say what the finding was, and two distinct
  // incidents about the same agent collapsed into one string could not re-escalate.
  const withheldIncidents: WithheldIncident[] = [];

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
    withheldIncidents.push(...deliverySplit.withheld.map((failure) => ({
      alarmClass: 'delivery' as const,
      subject: failure.agent,
      // One delivery finding per agent by construction, so the check name is the whole
      // stable identity. The detail embeds a live cursor position and stays out of it.
      identity: 'discordInboxDelivery',
      detail: failure.discordInboxDelivery.detail,
    })));
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
      alerts.push({ ...alertFrom(
        deliverySplit.deliverable,
        (agents) => formatDeliveryFailureAlert({ ...report, agents }),
        (failure) => failure.agent,
      ), channel: channelFor('delivery') });
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
      withheldIncidents.push(...recoverySplit.withheld.map((entry) => ({
        alarmClass: 'inboundRecovery' as const,
        subject: entry.agent,
        identity: entry.key,
        detail: `${entry.action}: ${entry.reason}`,
      })));
    }
    if (recoverySplit.deliverable.length > 0) {
      // `principal`, matching the inbound FAILURE class deliberately. This notice exists
      // because a repair must reach the same channel a failure would -- routing the repair
      // to the operator while the failure goes to Discord would recreate the split it was
      // built to close, in the change that introduced routing at all.
      alerts.push({ ...alertFrom(
        recoverySplit.deliverable,
        formatInboundRecoveryNotice,
        (entry) => entry.agent,
      ), channel: channelFor('inboundRecovery') });
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
    withheldIncidents.push(...inboundSplit.withheld.map((miss) => ({
      alarmClass: 'inbound' as const,
      subject: miss.agent,
      identity: miss.key,
      detail: miss.detail,
    })));
  }

  if (inboundSplit.deliverable.length === 0) {
    nextState.lastInboundReplyFingerprint = undefined;
  } else {
    const fingerprint = inboundSplit.fingerprint as string;
    if (state.lastInboundReplyFingerprint === fingerprint && !hasFlag('--repeat')) {
      process.stdout.write(`inbound reply monitor still failing; duplicate alert suppressed at ${inboundResult.checkedAtIso}\n`);
    } else {
      alerts.push({ ...alertFrom(
        inboundSplit.deliverable,
        (misses) => formatInboundReplyMissAlert({ ...inboundResult, misses }),
        (miss) => miss.agent,
      ), channel: channelFor('inbound') });
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
    withheldIncidents.push(...schedulerSplit.withheld.map((finding) => ({
      alarmClass: 'scheduler' as const,
      subject: finding.subject,
      // `check` is required: `identity` is empty for scalar checks, so without it two
      // different scalar checks about the same subject would share an identity and the
      // second would be suppressed -- blocker 1 in miniature.
      identity: finding.identity ? `${finding.check}:${finding.identity}` : finding.check,
      detail: finding.detail,
    })));
  }

  if (schedulerSplit.deliverable.length === 0) {
    nextState.lastSchedulerFingerprint = undefined;
  } else {
    const fingerprint = schedulerSplit.fingerprint as string;
    if (state.lastSchedulerFingerprint === fingerprint && !hasFlag('--repeat')) {
      process.stdout.write(`runtime scheduler monitor still failing; duplicate alert suppressed at ${report.generatedAtIso}\n`);
    } else {
      alerts.push({ ...alertFrom(
        schedulerSplit.deliverable,
        formatSchedulerAlert,
        (finding) => finding.subject,
      ), channel: channelFor('scheduler') });
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

  if (withheldIncidents.length > 0) {
    const withheldSubjects = withheldIncidents.map((incident) => incident.subject);
    // Counted ONCE and reused, so the log line and the escalation cannot disagree. NOTE THE
    // NAME: these are findings ADDRESSED to the operator, not findings delivered to it. The
    // count is taken from alerts assembled in memory, before any transport runs -- under
    // --dry-run none of them go anywhere at all. Reporting queued work as completed work was
    // eli's blocker 3, and it had leaked into both this line and the principal's message.
    const operatorAddressedCount = alerts.reduce((total, entry) => total + entry.subjects.length, 0);
    // THE SECOND HOP. Until 2026-09-26 this list reached stdout and nowhere else, which was
    // survivable only because delivery/inbound still had a principal path of their own. With
    // every class on `operator`, a finding about the operator would have had ZERO destinations
    // -- the 2026-09-12 defect with an extra step, and explicitly not an acceptable fix.
    //
    // THE PLAN IS BUILT BEFORE THE HEADER IS PRINTED, deliberately. The header's claim is only
    // true on one of the plan's three outcomes, so it has to read the decision rather than
    // predict it. The previous version printed the header first and asserted in a comment that
    // the two could not disagree -- while the planner recomputed the same predicate internally.
    // Ordering was the actual fix; the comment was not.
    //
    // Fingerprinted on stable INCIDENT IDENTITY so a standing condition is said once, not every
    // five minutes -- and so a NEW incident for an already-withheld subject still gets out. The
    // underlying findings keep re-raising in the log; the escalation does not repeat unchanged.
    //
    // This is the one alert built without `alertFrom`/`Deliverable`, and it does not violate
    // the partition: the rule is "never a finding into its own SUBJECT'S channel", and the
    // principal's DM is not the subject's channel. The subject is precisely why this message
    // exists. Constructing it through the deliverable path is impossible by design -- the
    // partition would withhold it again, forever.
    const escalation = planWithheldEscalation({
      incidents: withheldIncidents,
      destinationAgent: agent,
      operatorAddressedCount,
      lastFingerprint: state.lastWithheldFingerprint,
      repeat: hasFlag('--repeat'),
    });
    nextState.lastWithheldFingerprint = escalation.fingerprint;
    process.stdout.write(`${formatWithheldLogHeader({
      destinationAgent: agent,
      withheldCount: withheldIncidents.length,
      operatorAddressedCount,
      reason: withholdReason({ destinationAgent: agent, subjects: withheldSubjects }) ?? '',
      outcome: escalation.outcome,
    })}\n`);
    for (const incident of withheldIncidents) {
      process.stdout.write(`  withheld [${incident.alarmClass}] ${incident.subject} ${incident.identity}: ${incident.detail}\n`);
    }
    if (escalation.alert) alerts.push(escalation.alert);
  } else {
    nextState.lastWithheldFingerprint = undefined;
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
      // Route by the DECLARED destination, not by which sender is in scope here. An
      // operator finding reaching the principal's DM is the 2026-09-23 incident; a
      // principal finding quietly diverted to mail would be the same defect inverted,
      // which is why the tag is set where the finding is built and only read here.
      await dispatchRoutedAlert(entry, {
        operator: (alert) => sendOperatorMail({
          to: operatorAgent,
          subject: `runtime monitor: ${alert.subjects.length} finding(s) at ${report.generatedAtIso}`,
          body: alert.text,
          mailDir,
        }),
        principal: (alert) => sendDiscordMessage({ agent, chatId, text: alert.text, socketPath }),
      });
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
