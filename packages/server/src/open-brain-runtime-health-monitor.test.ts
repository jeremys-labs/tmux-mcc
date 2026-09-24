import { describe, expect, it, vi } from 'vitest';
import {
  alertFrom,
  deliveryFailureFingerprint,
  findDeliveryFailures,
  formatDeliveryFailureAlert,
  formatInboundRecoveryNotice,
  recoverDeliveryFailuresBeforeAlert,
  recoveryAttemptStillInGrace,
  withholdReason,
  monitorSummary,
  partitionBySubject,
  planAlertDispatch,
  ALERT_CHANNELS,
  channelFor,
  dispatchRoutedAlert,
  findSchedulerFailures,
  schedulerFailureFingerprint,
  formatSchedulerAlert,
  SCHEDULER_FLEET_SUBJECT,
} from './open-brain-runtime-health-monitor.js';
import type { RuntimeHealthReport } from './services/runtime-health.js';

function report(): RuntimeHealthReport {
  return {
    generatedAtIso: '2026-05-23T02:30:00.000Z',
    durationMs: 10,
    scheduler: {
      jobsFile: '/tmp/jobs.json',
      validJobTypes: ['once', 'recurring'],
      jobCount: 0,
      invalidTypeJobs: [],
      staleOneShotJobs: [],
      staleRecurringJobs: [],
      checks: {
        jobTypes: { status: 'ok', detail: 'ok' },
        staleOneShots: { status: 'ok', detail: 'ok' },
        staleRecurring: { status: 'ok', detail: 'ok' },
      },
    },
    agentMail: {
      dbPath: '/tmp/agent-mail.db',
      agents: {},
      outbox: { status: 'ok', detail: 'ok' },
    },
    summary: { status: 'error', detail: '1 non-ok check(s)' },
    agents: [{
      agent: 'zara',
      runtimeLaunchConfig: { status: 'ok', detail: 'ok' },
      runtimeType: { status: 'ok', detail: 'codex' },
      discordBridgeConfig: { status: 'ok', detail: 'ok' },
      codexInboundBridge: { status: 'ok', detail: 'ok' },
      discordInboxDelivery: { status: 'error', detail: '1 pending Discord inbox entries after cursor; oldest 2026-05-23T02:10:00.000Z (20m)' },
      codexOutboundDiscordMcp: { status: 'ok', detail: 'ok' },
      discordOutboundMcp: { status: 'ok', detail: 'ok' },
      openBrainMemoryKey: { status: 'ok', detail: 'ok' },
      lastOpenBrainCapture: { status: 'ok', detail: 'ok' },
      lastOpenBrainSearch: { status: 'unknown', detail: 'skipped' },
      groomingQueueDepth: { status: 'ok', detail: 'ok' },
      agentMail: { status: 'ok', detail: 'ok' },
      skillSnapshot: { status: 'ok', detail: 'ok' },
      migrationReadiness: { status: 'error', detail: 'delivery=error' },
    }],
  };
}

describe('runtime health monitor', () => {
  it('formats only delivery failures for alerting', () => {
    const failures = findDeliveryFailures(report());

    expect(failures.map((agent) => agent.agent)).toEqual(['zara']);
    expect(deliveryFailureFingerprint(failures)).toContain('zara:1 pending Discord inbox entries');
    expect(formatDeliveryFailureAlert(report())).toContain('- zara: 1 pending Discord inbox entries');
  });

  it('suppresses a recovered inbound miss for one fresh grace window, then allows alerting', () => {
    expect(recoveryAttemptStillInGrace({
      attemptedAt: '2026-08-26T13:10:00.000Z',
      checkedAt: '2026-08-26T13:19:59.999Z',
      graceMinutes: 10,
    })).toBe(true);
    expect(recoveryAttemptStillInGrace({
      attemptedAt: '2026-08-26T13:10:00.000Z',
      checkedAt: '2026-08-26T13:20:00.000Z',
      graceMinutes: 10,
    })).toBe(false);
  });

  it('restarts a stuck delivery before alerting and gives it a recovery window', async () => {
    const restart = vi.fn(async () => undefined);
    const first = await recoverDeliveryFailuresBeforeAlert({
      failures: findDeliveryFailures(report()),
      supervisorStatuses: [{ agent: 'zara', process: { status: 'running' }, progress: { status: 'idle' } }],
      attempts: {},
      checkedAt: '2026-08-26T13:10:00.000Z',
      graceMinutes: 10,
      dryRun: false,
      restart,
    });
    expect(restart).toHaveBeenCalledWith('zara');
    expect(first.alerts).toEqual([]);
    expect(first.attempts.zara?.attemptedAt).toBe('2026-08-26T13:10:00.000Z');

    const pending = await recoverDeliveryFailuresBeforeAlert({
      failures: findDeliveryFailures(report()),
      supervisorStatuses: [],
      attempts: first.attempts,
      checkedAt: '2026-08-26T13:19:59.999Z',
      graceMinutes: 10,
      dryRun: false,
      restart,
    });
    expect(pending.alerts).toEqual([]);
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it('alerts when forced delivery restart fails or its grace window expires', async () => {
    const failure = findDeliveryFailures(report());
    const failed = await recoverDeliveryFailuresBeforeAlert({
      failures: failure,
      supervisorStatuses: [],
      attempts: {},
      checkedAt: '2026-08-26T13:10:00.000Z',
      graceMinutes: 10,
      dryRun: false,
      restart: async () => { throw new Error('restart unavailable'); },
    });
    expect(failed.alerts[0].discordInboxDelivery.detail).toContain('forced runtime restart failed');

    const expired = await recoverDeliveryFailuresBeforeAlert({
      failures: failure,
      supervisorStatuses: [],
      attempts: { zara: { attemptedAt: '2026-08-26T13:10:00.000Z' } },
      checkedAt: '2026-08-26T13:20:00.000Z',
      graceMinutes: 10,
      dryRun: false,
      restart: async () => undefined,
    });
    expect(expired.alerts[0].discordInboxDelivery.detail).toContain('did not clear the queue');
  });
});

describe('a finding is never delivered into a subject\'s own channel (2026-09-12)', () => {
  it('withholds when the destination is the subject — the exact 09-12 failure', () => {
    // consumed_idle_no_reply for eli's dead runtime was posted into eli's own channel.
    const reason = withholdReason({ destinationAgent: 'eli', subjects: ['eli'] });
    expect(reason).not.toBeNull();
    expect(reason).toContain('eli');
  });

  it('delivers when the destination is not a subject', () => {
    expect(withholdReason({ destinationAgent: 'isla', subjects: ['dana'] })).toBeNull();
  });

  it('withholds when the destination is ONE OF SEVERAL subjects', () => {
    // The partial case: an alert about dana AND eli must not go to eli just because dana
    // is also in it. Over-blocking here is correct; under-blocking is the 09-12 bug.
    expect(withholdReason({ destinationAgent: 'eli', subjects: ['dana', 'eli'] })).not.toBeNull();
  });

  it('delivers an alert with no subjects — it cannot be about the destination', () => {
    expect(withholdReason({ destinationAgent: 'eli', subjects: [] })).toBeNull();
  });

  it('names every distinct subject in the reason, so the withheld finding is not lost', () => {
    // A withheld alert that does not say what it was about is the false close this
    // change exists to prevent.
    const reason = withholdReason({ destinationAgent: 'eli', subjects: ['dana', 'eli', 'dana'] });
    expect(reason).toContain('dana');
    expect(reason).toContain('eli');
    expect(reason?.match(/dana/g)).toHaveLength(1);
  });
});

describe('a bare ok is not a result', () => {
  it('states the denominator even when there is nothing to report', () => {
    const summary = monitorSummary({
      inboundFindings: 0, expectedCount: 1369, matchedCount: 1300,
      deferredCount: 60, skippedCount: 9, deliveryFindings: 0, agentsKnown: 15,
    });
    // Assert the WHOLE line. A red-verify showed that checking three substrings let most
    // of the denominator be deleted without any test noticing — the same assertion-strength
    // gap I have flagged in other people's work.
    expect(summary).toBe(
      'inbound 0 finding(s) over 1369 expectation(s) (matched 1300, deferred 60, skipped 9);'
      + ' delivery 0 finding(s) over 15 agent(s) known to the supervisor',
    );
  });

  it('distinguishes "nothing to report" from "looked at almost nothing"', () => {
    const healthy = monitorSummary({
      inboundFindings: 0, expectedCount: 1369, matchedCount: 1369,
      deferredCount: 0, skippedCount: 0, deliveryFindings: 0, agentsKnown: 15,
    });
    const blind = monitorSummary({
      inboundFindings: 0, expectedCount: 0, matchedCount: 0,
      deferredCount: 0, skippedCount: 0, deliveryFindings: 0, agentsKnown: 0,
    });
    // Both are "no findings". Only the denominator separates them, which is the entire point.
    expect(healthy).not.toEqual(blind);
    expect(blind).toContain('over 0 expectation(s)');
  });
});

describe('partition, do not drop — a finding is not lost because another subject shares its batch', () => {
  const f = (agent: string) => ({ agent }) as never;

  it('delivers the non-conflicting findings and withholds only the conflicting one', () => {
    // Isla is 625 of 1,369 breadcrumbs, so once she is the destination she appears in ~46%
    // of batches. Whole-batch withholding would suppress about half of every OTHER agent's
    // findings as collateral — a safety mechanism whose cost grows with its own adoption.
    const split = partitionBySubject([f('dana'), f('isla'), f('simone')], 'isla', (x: { agent: string }) => x.agent);
    expect(split.deliverable.map((x: { agent: string }) => x.agent)).toEqual(['dana', 'simone']);
    expect(split.withheld.map((x: { agent: string }) => x.agent)).toEqual(['isla']);
  });

  it('withholds everything when every subject is the destination', () => {
    const split = partitionBySubject([f('isla'), f('isla')], 'isla', (x: { agent: string }) => x.agent);
    expect(split.deliverable).toHaveLength(0);
    expect(split.withheld).toHaveLength(2);
  });

  it('delivers everything when no subject is the destination', () => {
    const split = partitionBySubject([f('dana'), f('eli')], 'isla', (x: { agent: string }) => x.agent);
    expect(split.withheld).toHaveLength(0);
    expect(split.deliverable).toHaveLength(2);
  });
});

describe('a withheld finding must never advance the dedup fingerprint', () => {
  // Eli's must-fix on b49fd06: fingerprints were written at QUEUE time, so a withheld
  // finding marked itself as sent and the next run suppressed it as a duplicate — announced
  // once to stdout and then silent forever. Worse than the 09-12 bug it replaces, because
  // 09-12 at least kept shouting into the wrong channel.
  // The fingerprint reads `discordInboxDelivery.detail`, so the fixture must carry it.
  // My first version omitted it and threw — loudly, which is the good failure. A fixture
  // that is merely degenerate rather than absent would have made both fingerprints equal
  // and passed this test for the wrong reason.
  const failure = (agent: string) => ({
    agent,
    discordInboxDelivery: { detail: `undelivered for ${agent}` },
  }) as never;

  const plan = (agents: string[], destination: string) => planAlertDispatch({
    items: agents.map(failure),
    destinationAgent: destination,
    subjectOf: (x: { agent: string }) => x.agent,
    fingerprintOf: deliveryFailureFingerprint,
  });

  it('the fingerprint covers ONLY what was delivered, never the withheld subject', () => {
    const result = plan(['dana', 'isla'], 'isla');
    expect(result.fingerprint).toBe(deliveryFailureFingerprint([failure('dana')] as never));
    expect(result.fingerprint).not.toContain('isla');
  });

  it('an entirely withheld batch produces a NULL fingerprint, so nothing is recorded as handled', () => {
    // The re-raise property: withholding means nobody has been told, so the finding must
    // come back every run until someone routes it.
    const result = plan(['isla'], 'isla');
    expect(result.deliverable).toHaveLength(0);
    expect(result.fingerprint).toBeNull();
  });

  it('a batch with nothing withheld fingerprints the whole set', () => {
    const result = plan(['dana', 'eli'], 'isla');
    expect(result.withheld).toHaveLength(0);
    expect(result.fingerprint).toBe(deliveryFailureFingerprint([failure('dana'), failure('eli')] as never));
  });
});

describe('a repair must reach the same channel a failure would (2026-09-13 RECOVERY ROUTING)', () => {
  // Before this fix, `recoverInboundMiss` succeeding only wrote a stdout line — if that was
  // the only thing that happened this pass, `alerts.length === 0` returned before anyone
  // outside a log reader learned a repair had occurred. This suite covers the notice that
  // now routes a recovery through the same alertFrom/planAlertDispatch path as a failure.
  const recovered = (agent: string, key = `${agent}:miss`) => ({
    key, agent, action: 'replay_consumed', reason: `queued message replayed for ${agent}`,
  });

  it('formats a plain-language notice naming the agent, action, and reason', () => {
    const text = formatInboundRecoveryNotice([recovered('dana')]);
    expect(text).toContain('dana');
    expect(text).toContain('replay_consumed');
    expect(text).toContain('queued message replayed for dana');
    expect(text).toContain('self-healed 1 inbound miss(es)');
  });

  it('a recovery notice about the destination itself is withheld, never routed to its own channel', () => {
    // Same invariant as a failure alert (2026-09-12): a finding about the destination agent
    // cannot be delivered into that agent's own channel.
    const split = planAlertDispatch({
      items: [recovered('eli'), recovered('dana')],
      destinationAgent: 'eli',
      subjectOf: (entry) => entry.agent,
      fingerprintOf: (entries) => entries.map((entry) => entry.key).sort().join(','),
    });
    expect(split.deliverable.map((entry) => entry.agent)).toEqual(['dana']);
    expect(split.withheld.map((entry) => entry.agent)).toEqual(['eli']);
  });

  it('a delivered recovery becomes an alert entry carrying the recovered agent as its subject', () => {
    const split = planAlertDispatch({
      items: [recovered('dana')],
      destinationAgent: 'eli',
      subjectOf: (entry) => entry.agent,
      fingerprintOf: (entries) => entries.map((entry) => entry.key).sort().join(','),
    });
    const alert = alertFrom(split.deliverable, formatInboundRecoveryNotice, (entry) => entry.agent);
    expect(alert.subjects).toEqual(['dana']);
    expect(alert.text).toContain('self-healed');
    expect(alert.text).toContain('dana');
  });

  it('multiple recoveries in one pass are named individually, not collapsed into a count', () => {
    const text = formatInboundRecoveryNotice([recovered('dana'), recovered('simone', 'simone:miss')]);
    expect(text).toContain('self-healed 2 inbound miss(es)');
    expect(text).toContain('dana');
    expect(text).toContain('simone');
  });
});


describe('scheduler checks reach a channel at all (dc-20260919-003)', () => {
  // Until this class existed, `report.scheduler` had NO scheduled consumer. The 5-minute
  // monitor read `discordInboxDelivery` and the inbound reconcile and nothing else, so a
  // non-ok scheduler check was computed every run and reached no one. `grep -c scheduler`
  // in the monitor was 0. (Eli's trace on PR #29.) These tests pin that it is read.
  function schedulerReport(checks: Record<string, { status: string; detail: string }>, staleJobs: Array<{ id: string; label: string; agent?: string; cron: string; reason: string }> = [], oneShots: Array<{ id: string; label: string; fireAt: string; staleMinutes: number }> = []) {
    const base = report();
    base.scheduler.checks = { ...base.scheduler.checks, ...checks } as never;
    base.scheduler.staleRecurringJobs = staleJobs as never;
    base.scheduler.staleOneShotJobs = oneShots as never;
    return base;
  }

  it('turns a non-ok scheduler check into a DELIVERED alert', () => {
    const r = schedulerReport({
      schedulerTickPhase: { status: 'error', detail: 'scheduler tick phase 45000ms of a 600000ms tick - ticks are landing far from the boundary' },
    });
    const findings = findSchedulerFailures(r);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ check: 'schedulerTickPhase', status: 'error', subject: SCHEDULER_FLEET_SUBJECT });

    const split = planAlertDispatch({
      items: findings,
      destinationAgent: 'isla',
      subjectOf: (f) => f.subject,
      fingerprintOf: schedulerFailureFingerprint,
    });
    // Fleet-level: the subject is not an agent, so it can never collide with a destination.
    expect(split.withheld).toHaveLength(0);
    expect(split.deliverable).toHaveLength(1);
    expect(formatSchedulerAlert(split.deliverable)).toContain('45000ms');
  });

  it('keeps `unknown` distinct from `error` instead of folding it into ok', () => {
    // "I could not tell" and "the scheduler is broken" have different remedies. Folding
    // unknown into ok is the false-clean this row exists to prevent; folding it into error
    // pages someone for a missing file. It alarms, and it says which it is.
    const r = schedulerReport({
      schedulerHeartbeat: { status: 'unknown', detail: 'no heartbeat file to read' },
    });
    const findings = findSchedulerFailures(r);
    expect(findings).toHaveLength(1);
    expect(findings[0].status).toBe('unknown');
  });

  // THE DEDUPE CONTRACT. The version of this test on f477335 asserted that
  // 45000ms -> 61000ms should re-raise, and called that "the finding changed". It is not a
  // new incident, it is a new SAMPLE of the same one -- and because scheduler details embed
  // live telemetry (current phaseMs; a heartbeat age in seconds that grows every run), that
  // made one continuing incident alert every five minutes while the test called it correct.
  // A test can encode the defect as the specification. (Eli, blocker on f477335.)
  it('does NOT re-alert when only the measurement changes', () => {
    const a = findSchedulerFailures(schedulerReport({
      schedulerTickPhase: { status: 'error', detail: 'scheduler tick phase 45000ms of a 600000ms tick' },
    }));
    const b = findSchedulerFailures(schedulerReport({
      schedulerTickPhase: { status: 'error', detail: 'scheduler tick phase 61000ms of a 600000ms tick' },
    }));
    expect(a[0].detail).not.toBe(b[0].detail);              // the display really did change
    expect(schedulerFailureFingerprint(a)).toBe(schedulerFailureFingerprint(b)); // identity did not
  });

  it('DOES re-alert on a severity transition', () => {
    const warn = findSchedulerFailures(schedulerReport({
      schedulerTickPhase: { status: 'warn', detail: 'phase 7000ms' },
    }));
    const error = findSchedulerFailures(schedulerReport({
      schedulerTickPhase: { status: 'error', detail: 'phase 7000ms' },
    }));
    expect(schedulerFailureFingerprint(warn)).not.toBe(schedulerFailureFingerprint(error));
  });

  it('DOES re-alert when the affected set changes membership', () => {
    const one = findSchedulerFailures(schedulerReport(
      { staleRecurring: { status: 'warn', detail: 'stale jobs' } },
      [{ id: 'j1', label: 'a', agent: 'nova', cron: '0 3 * * *', reason: 'no job log found' }],
    ));
    const two = findSchedulerFailures(schedulerReport(
      { staleRecurring: { status: 'warn', detail: 'stale jobs' } },
      [
        { id: 'j1', label: 'a', agent: 'nova', cron: '0 3 * * *', reason: 'no job log found' },
        { id: 'j2', label: 'b', agent: 'nova', cron: '0 4 * * *', reason: 'no job log found' },
      ],
    ));
    expect(schedulerFailureFingerprint(one)).not.toBe(schedulerFailureFingerprint(two));
  });

  it('is stable when a set is re-reported in a different order', () => {
    // Otherwise "membership changed" would fire on nothing more than iteration order.
    const forward = findSchedulerFailures(schedulerReport(
      { staleRecurring: { status: 'warn', detail: 'stale jobs' } },
      [
        { id: 'j1', label: 'a', agent: 'nova', cron: '0 3 * * *', reason: 'r' },
        { id: 'j2', label: 'b', agent: 'nova', cron: '0 4 * * *', reason: 'r' },
      ],
    ));
    const reversed = findSchedulerFailures(schedulerReport(
      { staleRecurring: { status: 'warn', detail: 'stale jobs' } },
      [
        { id: 'j2', label: 'b', agent: 'nova', cron: '0 4 * * *', reason: 'r' },
        { id: 'j1', label: 'a', agent: 'nova', cron: '0 3 * * *', reason: 'r' },
      ],
    ));
    expect(schedulerFailureFingerprint(forward)).toBe(schedulerFailureFingerprint(reversed));
  });

  it('is stable under set order for the SCALAR set-valued checks too, not just staleRecurring', () => {
    // My first version of the order test used staleRecurring only. Dropping `.sort()` from
    // the staleOneShots identity then survived the mutation -- one outcome (a set-valued
    // identity) reached by two code paths, with the control covering one. Found by probing
    // my own fix, not by reading it.
    const one = (a: string, b: string) => findSchedulerFailures(schedulerReport(
      { staleOneShots: { status: 'warn', detail: 'stale one-shots' } },
      [],
      [
        { id: a, label: a, fireAt: '2026-09-01T00:00:00Z', staleMinutes: 99 },
        { id: b, label: b, fireAt: '2026-09-01T00:00:00Z', staleMinutes: 99 },
      ],
    ));
    expect(schedulerFailureFingerprint(one('s1', 's2'))).toBe(schedulerFailureFingerprint(one('s2', 's1')));
  });

  it('WITHHOLDS a stale-job finding about the destination and leaves a positive record', () => {
    // The withheld path is reachable for this class ONLY because staleRecurring findings
    // carry the owning agent. A stale job usually means that agent's runtime is unwell, so
    // "your job has not run" into that agent's own channel is the 2026-09-12 defect.
    //
    // And the record must be POSITIVE. A withheld finding and an undetected one are both
    // "no alert in that channel", so absence cannot be the evidence that withholding
    // happened -- which is why this asserts the withheld subject by name.
    const r = schedulerReport(
      { staleRecurring: { status: 'warn', detail: '2 recurring job(s) have stale or missing logs' } },
      [
        { id: 'j1', label: 'isla nightly', agent: 'isla', cron: '0 3 * * *', reason: 'no job log found' },
        { id: 'j2', label: 'nova weekly', agent: 'nova', cron: '0 4 * * 1', reason: 'no job log found' },
      ],
    );
    const findings = findSchedulerFailures(r);
    expect(findings.map((f) => f.subject).sort()).toEqual(['isla', 'nova']);

    const split = planAlertDispatch({
      items: findings,
      destinationAgent: 'isla',
      subjectOf: (f) => f.subject,
      fingerprintOf: schedulerFailureFingerprint,
    });
    // PARTITION, NOT DROP: nova's finding still ships in the same run.
    expect(split.withheld.map((f) => f.subject)).toEqual(['isla']);
    expect(split.deliverable.map((f) => f.subject)).toEqual(['nova']);
    // The withheld finding must NOT be in the fingerprint, or it marks itself sent and is
    // suppressed forever -- worse than 09-12, which at least kept shouting.
    expect(split.fingerprint).not.toContain('isla');
    expect(split.fingerprint).toContain('nova');
  });
});


describe('where each alarm class speaks (dc-20260923-003)', () => {
  // 2026-09-23: the scheduler class's first live run put ~5,600 characters of stale-job
  // UUIDs into the principal's DM. Operator diagnostics and principal escalation shared a
  // destination because they shared a code path, and nothing named which was which.
  //
  // Repointing the Discord flag was never available: start-runtime-health-monitor.sh lists
  // precedence "1. isla 2. Jeremy's DM" and BOTH resolve to the same channel id. (Isla.)

  it('sends operator diagnostics to the operator, not the principal', () => {
    expect(channelFor('scheduler')).toBe('operator');
  });

  it('leaves the classes it did not own on the principal channel', () => {
    // Silently re-routing someone else's alarm class while fixing mine would be the same
    // move in the other direction.
    expect(channelFor('delivery')).toBe('principal');
    expect(channelFor('inbound')).toBe('principal');
  });

  it('keeps a repair on the SAME channel as the failure it repairs', () => {
    // Asserted as an EQUALITY against inbound, not as the literal 'principal'. The literal
    // passes even if inbound later moves and recovery does not -- and that divergence is
    // exactly the split `formatInboundRecoveryNotice` exists to close: on 2026-09-13 a
    // successful self-repair went to a log file while its failure went to Discord, so six
    // recoveries across five agents were invisible and Dana acted on a $4k payload twice.
    //
    // The weaker assertion would be true of both the correct and the broken arrangement,
    // which is the shape that made my channel mislabel survive a green suite.
    expect(channelFor('inboundRecovery')).toBe(channelFor('inbound'));
  });

  it('forces a destination decision for every class, with no silent default', () => {
    // The Record type makes a missing entry a compile error; this pins that no class was
    // added to the table without one, and that the table has not grown a member nothing
    // routes through.
    expect(Object.keys(ALERT_CHANNELS).sort()).toEqual(
      ['delivery', 'inbound', 'inboundRecovery', 'scheduler'],
    );
    for (const channel of Object.values(ALERT_CHANNELS)) {
      expect(['principal', 'operator']).toContain(channel);
    }
  });

  it('dispatches an operator-tagged alert only through the operator transport', async () => {
    const principal = vi.fn(async () => undefined);
    const operator = vi.fn(async () => undefined);
    const alert = { text: 'scheduler detail', subjects: ['remy'], channel: 'operator' as const };

    await dispatchRoutedAlert(alert, { principal, operator });

    expect(operator).toHaveBeenCalledWith(alert);
    expect(principal).not.toHaveBeenCalled();
  });

  it('dispatches a principal-tagged alert only through the principal transport', async () => {
    const principal = vi.fn(async () => undefined);
    const operator = vi.fn(async () => undefined);
    const alert = { text: 'decision needed', subjects: ['remy'], channel: 'principal' as const };

    await dispatchRoutedAlert(alert, { principal, operator });

    expect(principal).toHaveBeenCalledWith(alert);
    expect(operator).not.toHaveBeenCalled();
  });

  it('propagates operator transport failure instead of recording a silent delivery', async () => {
    await expect(dispatchRoutedAlert(
      { text: 'scheduler detail', subjects: ['remy'], channel: 'operator' },
      {
        principal: vi.fn(async () => undefined),
        operator: vi.fn(async () => { throw new Error('agent-mail failed'); }),
      },
    )).rejects.toThrow('agent-mail failed');
  });
});
