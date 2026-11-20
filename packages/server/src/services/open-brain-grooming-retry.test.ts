import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_GROOMING_ATTEMPTS,
  buildScheduledGroomingDigest,
  runScheduledGrooming,
  type GroomingActionSummary,
} from './open-brain-grooming-schedule.js';
import type { GroomingRawCaptureRow } from './open-brain-grooming-review.js';

const row: GroomingRawCaptureRow = {
  id: 'row-1',
  created_at: '2026-11-03T12:00:00.000Z',
  content: 'A durable project decision that requires classification.',
  metadata: {
    owner_agent: 'zara',
    project: 'agent-runtime',
    source_type: 'manual',
    source_ref: 'manual:retry-1',
  },
};

const summary: GroomingActionSummary = {
  itemAutoIgnored: 0,
  itemAutoPromotedPrivate: 0,
  itemAutoPromotedProject: 0,
  itemNeedsReview: 0,
  clusterIgnored: 0,
  clusterSkipped: 0,
  clusterAutoPromotedPrivate: 0,
  clusterAutoPromotedProject: 0,
  clusterNeedsReview: 0,
};

type TestDependencies = NonNullable<Parameters<typeof runScheduledGrooming>[0]['dependencies']>;

function dependencies(overrides: Partial<TestDependencies> = {}): TestDependencies {
  return {
    readState: () => ({}),
    fetchSince: async () => [row],
    fetchByIds: async () => [],
    classifyWithOpenBrain: async () => ({
      action: 'auto_promote_private' as const,
      scope: 'private_agent' as const,
      reason: 'durable',
    }),
    applyItem: async () => 'promoted',
    applyCluster: async () => 'cluster_skipped',
    patchMetadata: async () => undefined,
    ...overrides,
  };
}

afterEach(() => {
  delete process.env.OPEN_BRAIN_GROOMING_CLASSIFIER_ENABLED;
});

describe('open brain grooming retry queue', () => {
  it('advances the new-row cursor while retaining a classifier failure for retry', async () => {
    process.env.OPEN_BRAIN_GROOMING_CLASSIFIER_ENABLED = '1';
    const result = await runScheduledGrooming({
      actorAgent: 'zara',
      generatedAtIso: '2026-11-03T13:00:00.000Z',
      dependencies: dependencies({
        classifyWithOpenBrain: async () => { throw new Error('classifier unavailable'); },
      }),
    });

    expect(result.maxProcessedCreatedAt).toBe(row.created_at);
    expect(result.classifierFailureCount).toBe(1);
    expect(result.retryQueue).toEqual([{
      rowId: 'row-1',
      sourceRef: 'manual:retry-1',
      attempts: 1,
      stage: 'classifier',
      lastError: 'Error: classifier unavailable',
    }]);
  });

  it('queues an apply failure instead of losing it behind the cursor', async () => {
    process.env.OPEN_BRAIN_GROOMING_CLASSIFIER_ENABLED = '1';
    const result = await runScheduledGrooming({
      actorAgent: 'zara',
      generatedAtIso: '2026-11-03T13:00:00.000Z',
      dependencies: dependencies({
        applyItem: async () => { throw new Error('promotion write failed'); },
      }),
    });

    expect(result.applyFailureCount).toBe(1);
    expect(result.retryQueue[0]).toMatchObject({
      sourceRef: 'manual:retry-1',
      attempts: 1,
      stage: 'apply',
    });
  });

  it('processes distinct rows that share a source reference', async () => {
    process.env.OPEN_BRAIN_GROOMING_CLASSIFIER_ENABLED = '1';
    const applyItem = vi.fn(async () => 'promoted');
    const result = await runScheduledGrooming({
      actorAgent: 'zara',
      generatedAtIso: '2026-11-03T13:00:00.000Z',
      dependencies: dependencies({
        fetchSince: async () => [row, { ...row, id: 'row-2' }],
        applyItem,
      }),
    });

    expect(result.rawCaptureCount).toBe(2);
    expect(applyItem).toHaveBeenCalledTimes(2);
  });

  it('marks a row grooming_failed when the retry cap is reached', async () => {
    process.env.OPEN_BRAIN_GROOMING_CLASSIFIER_ENABLED = '1';
    const patchMetadata = vi.fn(async () => undefined);
    const result = await runScheduledGrooming({
      actorAgent: 'zara',
      generatedAtIso: '2026-11-03T13:00:00.000Z',
      dependencies: dependencies({
        readState: () => ({
          retryQueue: [{
            rowId: 'row-1',
            sourceRef: 'manual:retry-1',
            attempts: MAX_GROOMING_ATTEMPTS - 1,
            stage: 'classifier' as const,
            lastError: 'prior failure',
          }],
        }),
        fetchSince: async () => [],
        fetchByIds: async () => [row],
        classifyWithOpenBrain: async () => { throw new Error('classifier unavailable'); },
        patchMetadata,
      }),
    });

    expect(result.retryQueue).toEqual([]);
    expect(result.terminalFailureCount).toBe(1);
    expect(patchMetadata).toHaveBeenCalledWith('row-1', expect.objectContaining({
      grooming_status: 'grooming_failed',
      grooming_failure_attempts: MAX_GROOMING_ATTEMPTS,
      grooming_failure_stage: 'classifier',
    }));
  });

  it('reports failures and the real retry policy in the digest', () => {
    const digest = buildScheduledGroomingDigest(
      [row],
      [],
      [],
      {
        sinceIso: '2026-11-03T12:00:00.000Z',
        generatedAtIso: '2026-11-03T13:00:00.000Z',
        channelId: 'unused',
      },
      summary,
      [],
      3,
      1,
      0,
    );

    expect(digest).toContain('Grooming failures: 1');
    expect(digest).toContain(`retry up to ${MAX_GROOMING_ATTEMPTS} attempts`);
    expect(digest).not.toContain('Rows are staying in raw_capture and will retry.');
  });
});
