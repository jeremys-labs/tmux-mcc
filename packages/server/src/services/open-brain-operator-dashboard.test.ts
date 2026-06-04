import { describe, expect, it } from 'vitest';
import {
  buildOperatorDashboardModel,
  formatOperatorDashboard,
} from './open-brain-operator-dashboard.js';
import type { OpenBrainMeasurementEvent } from './open-brain-measurements.js';

function event(partial: Partial<OpenBrainMeasurementEvent>): OpenBrainMeasurementEvent {
  return {
    schema_version: 1,
    id: `id-${partial.criterion}`,
    ts: '2026-06-04T20:00:00.000Z',
    system: 'ob1',
    area: 'grooming',
    criterion: partial.criterion ?? 'grooming_run_completed',
    owner_agent: partial.owner_agent ?? 'eli',
    expected: {},
    actual: partial.actual ?? {},
    passed: partial.passed ?? true,
    status: partial.status ?? 'pass',
    evidence_ref: partial.evidence_ref ?? 'test',
  };
}

describe('open brain operator dashboard', () => {
  it('aggregates grooming measurements and live pending raw captures by agent', () => {
    const model = buildOperatorDashboardModel({
      sinceIso: '2026-06-04T00:00:00.000Z',
      nowIso: '2026-06-04T22:00:00.000Z',
      digestState: {
        lastRunIso: '2026-06-04T21:30:00.000Z',
        classifierFailureCycles: 0,
        pendingReviewCandidates: [],
      },
      lastDecisionDigest: {
        generatedAtIso: '2026-06-04T13:30:00.000Z',
        channelId: 'discord',
        count: 2,
        digestText: 'digest',
        entries: [],
      },
      measurementEvents: [
        event({
          criterion: 'grooming_run_completed',
          owner_agent: 'grooming-bot',
          actual: { raw_capture_count: 12 },
        }),
        event({
          criterion: 'grooming_actions_measured',
          owner_agent: 'grooming-bot',
          actual: { auto_promoted_count: 5, ignored_count: 4, needs_review_count: 3 },
        }),
      ],
      rawCaptures: [
        {
          id: '1',
          created_at: '2026-06-04T21:00:00.000Z',
          content: 'pending',
          metadata: { owner_agent: 'lena', source_type: 'discord' },
        },
        {
          id: '2',
          created_at: '2026-06-04T21:01:00.000Z',
          content: 'pending',
          metadata: { owner_agent: 'lena', source_type: 'agent_mail' },
        },
      ],
    });

    expect(model.agents.find((a) => a.agent === 'grooming-bot')).toMatchObject({
      rawCaptureCount: 12,
      autoPromoted: 5,
      ignored: 4,
      needsReview: 3,
    });
    expect(model.agents.find((a) => a.agent === 'lena')).toMatchObject({
      pendingRawCaptures: 2,
    });
    expect(model.pendingBySource).toEqual([
      { sourceType: 'agent_mail', count: 1 },
      { sourceType: 'discord', count: 1 },
    ]);
    expect(formatOperatorDashboard(model)).toContain('Last decision digest: 2026-06-04T13:30:00.000Z (2 entries)');
  });

  it('warns on stale grooming, pending review, classifier failures, and large pending queues', () => {
    const model = buildOperatorDashboardModel({
      sinceIso: '2026-06-04T00:00:00.000Z',
      nowIso: '2026-06-04T22:00:00.000Z',
      digestState: {
        lastRunIso: '2026-06-04T18:00:00.000Z',
        classifierFailureCycles: 2,
        pendingReviewCandidates: [{ sourceRef: 'discord:1' }],
      },
      lastDecisionDigest: null,
      measurementEvents: [
        event({
          criterion: 'grooming_classifier_healthy',
          owner_agent: 'grooming-bot',
          actual: { classifier_failure_count: 1 },
          passed: false,
          status: 'warn',
        }),
      ],
      rawCaptures: Array.from({ length: 51 }, (_, index) => ({
        id: String(index),
        created_at: '2026-06-04T21:00:00.000Z',
        content: 'pending',
        metadata: { owner_agent: 'eli', source_type: 'discord' },
      })),
    });

    expect(model.warnings).toContain('Grooming last run is older than 2h: 2026-06-04T18:00:00.000Z.');
    expect(model.warnings).toContain('Classifier failure cycles: 2.');
    expect(model.warnings).toContain('Pending review candidates in state: 1.');
    expect(model.warnings).toContain('eli has 51 live unresolved raw captures.');
    expect(model.warnings).toContain('grooming-bot classifier failures in window: 1.');
  });
});
