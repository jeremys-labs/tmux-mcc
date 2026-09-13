import { describe, expect, it, vi } from 'vitest';
import {
  deliveryFailureFingerprint,
  findDeliveryFailures,
  formatDeliveryFailureAlert,
  recoverDeliveryFailuresBeforeAlert,
  recoveryAttemptStillInGrace,
  withholdReason,
  monitorSummary,
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
    // The number that three people read source code to find.
    expect(summary).toContain('1369');
    expect(summary).toContain('15 agent(s)');
    expect(summary).toContain('0 finding(s)');
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
