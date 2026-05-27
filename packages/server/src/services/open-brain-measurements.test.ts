import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  appendOpenBrainMeasurements,
  buildOpenBrainGroomingMeasurements,
  resolveOpenBrainMeasurementsPath,
} from './open-brain-measurements.js';
import type { GroomingScheduledResult } from './open-brain-grooming-schedule.js';

function baseResult(overrides: Partial<GroomingScheduledResult> = {}): GroomingScheduledResult {
  return {
    digest: 'OB1 digest',
    sinceIso: '2026-05-27T13:00:00.000Z',
    generatedAtIso: '2026-05-27T14:00:00.000Z',
    rawCaptureCount: 7,
    itemPlans: [],
    clusterPlans: [],
    summary: {
      itemAutoIgnored: 1,
      itemAutoPromotedPrivate: 2,
      itemAutoPromotedProject: 1,
      itemNeedsReview: 1,
      clusterIgnored: 1,
      clusterSkipped: 1,
      clusterAutoPromotedPrivate: 0,
      clusterAutoPromotedProject: 1,
      clusterNeedsReview: 1,
    },
    reviewCandidates: [{
      kind: 'item',
      key: 'agent-mail:1',
      sourceRef: 'agent-mail:1',
      project: 'ob1-memory',
      text: 'Review this memory.',
      reason: 'policy-sensitive',
      recommendedAction: 'Promote to project memory.',
      proposedMemory: 'Review this memory.',
      evidence: [],
    }],
    classifierFailureCount: 0,
    classifierFailureCycles: 0,
    applyFailureCount: 0,
    ...overrides,
  };
}

describe('open brain measurements', () => {
  it('builds pass/fail measurement events for a grooming run', () => {
    const events = buildOpenBrainGroomingMeasurements(baseResult({
      classifierFailureCount: 1,
      classifierFailureCycles: 2,
      applyFailureCount: 3,
    }), {
      generatedAtIso: '2026-05-27T14:00:00.000Z',
      sinceIso: '2026-05-27T13:00:00.000Z',
      ownerAgent: 'eli',
      pendingReviewCount: 4,
    });

    expect(events.map((event) => event.criterion)).toEqual([
      'grooming_run_completed',
      'grooming_actions_measured',
      'grooming_review_queue_measured',
      'grooming_classifier_healthy',
      'grooming_apply_healthy',
    ]);
    expect(events[1]?.actual).toMatchObject({
      auto_promoted_count: 4,
      ignored_count: 2,
      needs_review_count: 2,
    });
    expect(events[2]?.actual).toEqual({
      new_review_candidates: 1,
      pending_review_count: 4,
    });
    expect(events[3]).toMatchObject({ passed: false, status: 'warn' });
    expect(events[4]).toMatchObject({ passed: false, status: 'fail' });
  });

  it('appends JSONL measurements under the persistent open-brain content root', () => {
    const contentRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ob1-measurements-'));
    const events = buildOpenBrainGroomingMeasurements(baseResult(), {
      generatedAtIso: '2026-05-27T14:00:00.000Z',
      sinceIso: '2026-05-27T13:00:00.000Z',
      ownerAgent: 'eli',
      pendingReviewCount: 1,
    });

    const ledgerPath = appendOpenBrainMeasurements(events, { contentRoot });
    const expectedPath = resolveOpenBrainMeasurementsPath(contentRoot);
    const rows = fs.readFileSync(ledgerPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));

    expect(ledgerPath).toBe(expectedPath);
    expect(rows).toHaveLength(5);
    expect(rows[0]).toMatchObject({
      schema_version: 1,
      system: 'ob1',
      area: 'grooming',
      criterion: 'grooming_run_completed',
      owner_agent: 'eli',
      passed: true,
      evidence_ref: 'open-brain:grooming-digest:2026-05-27T14:00:00.000Z',
    });
  });
});
