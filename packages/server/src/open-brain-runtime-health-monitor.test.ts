import { describe, expect, it } from 'vitest';
import {
  deliveryFailureFingerprint,
  findDeliveryFailures,
  formatDeliveryFailureAlert,
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
});
