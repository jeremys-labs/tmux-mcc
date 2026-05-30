import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  buildGroomingDigest,
  defaultSinceIso,
  readLastDecisionDigest,
  writeLastDecisionDigest,
  type LastDecisionDigestRecord,
  type RawCaptureRow,
} from './open-brain-grooming-digest.js';
import {
  buildPendingReviewDigest,
  buildScheduledGroomingDigest,
  mergeReviewCandidates,
  type GroomingActionSummary,
  type GroomingClusterPlan,
  type GroomingItemPlan,
} from './open-brain-grooming-schedule.js';
import type { GroomingReviewRow } from './open-brain-grooming-review.js';

describe('open brain grooming digest', () => {
  it('uses the previous run timestamp when available', () => {
    expect(defaultSinceIso(new Date('2026-04-28T12:00:00.000Z'), { lastRunIso: '2026-04-28T01:00:00.000Z' }))
      .toBe('2026-04-28T01:00:00.000Z');
  });

  it('falls back to the previous 24 hours without state', () => {
    expect(defaultSinceIso(new Date('2026-04-28T12:00:00.000Z'), {}))
      .toBe('2026-04-27T12:00:00.000Z');
  });

  it('formats raw captures without promoting memory', () => {
    const rows: RawCaptureRow[] = [{
      created_at: '2026-04-28T03:34:56.100Z',
      content: [
        'Raw capture candidate for eli from Discord.',
        'At 2026-04-28T03:34:54.161Z, Jeremy wrote:',
        'How do we verify the raw_capture?',
        'This is a candidate runtime capture for later grooming, not source-of-truth memory.',
      ].join('\n'),
      metadata: {
        source_type: 'discord',
        source_ref: 'discord:1498527906287321088',
        project: 'agent-runtime',
      },
    }];

    const digest = buildGroomingDigest(rows, {
      sinceIso: '2026-04-28T00:00:00.000Z',
      generatedAtIso: '2026-04-28T04:00:00.000Z',
      channelId: 'c1',
    });

    expect(digest).toContain('Raw captures: 1');
    expect(digest).toContain('Sources: discord: 1');
    expect(digest).toContain('discord:1498527906287321088 [agent-runtime]');
    expect(digest).toContain('How do we verify the raw_capture?');
    expect(digest).toContain('promote <source_ref> private_agent|project|shared_team');
    expect(digest).toContain('No memory was promoted or deprecated automatically.');
  });

  it('formats a scheduled grooming digest with action summary and review candidates', () => {
    const row: GroomingReviewRow = {
      id: 'row-1',
      content: 'Raw capture candidate.\nPotentially shared-team item.',
      metadata: {
        owner_agent: 'eli',
        project: 'ob1-memory',
        source_type: 'discord',
        source_ref: 'discord:1',
      },
    };
    const itemPlans: GroomingItemPlan[] = [{
      row,
      classification: { action: 'needs_review', reason: 'shared/team or policy-sensitive memory' },
    }];
    const clusterPlans: GroomingClusterPlan[] = [{
      cluster: { key: 'eli|ob1-memory|discord', rows: [row, row, row] },
      classification: { action: 'cluster_needs_review', reason: 'contains policy-sensitive item: shared/team or policy-sensitive memory' },
    }];
    const summary: GroomingActionSummary = {
      itemAutoIgnored: 0,
      itemAutoPromotedPrivate: 0,
      itemAutoPromotedProject: 0,
      itemNeedsReview: 1,
      clusterIgnored: 0,
      clusterSkipped: 0,
      clusterAutoPromotedPrivate: 0,
      clusterAutoPromotedProject: 0,
      clusterNeedsReview: 1,
    };

    const digest = buildScheduledGroomingDigest(
      [row],
      itemPlans,
      clusterPlans,
      {
        sinceIso: '2026-04-28T00:00:00.000Z',
        generatedAtIso: '2026-04-28T04:00:00.000Z',
        channelId: 'c1',
      },
      summary,
      [{
        kind: 'item',
        key: 'discord:1',
        sourceRef: 'discord:1',
        project: 'ob1-memory',
        text: 'Potentially shared-team item.',
        reason: 'shared/team or policy-sensitive memory',
        recommendedAction: 'Promote to project memory unless this is approved team truth; do not promote shared_team from this digest alone.',
        proposedMemory: 'Potentially shared-team item.',
        evidence: ['discord:1\ncontent:\nRaw capture candidate.\nPotentially shared-team item.'],
      }],
    );

    expect(digest).toContain('Action summary:');
    expect(digest).toContain('Item needs review: 1');
    expect(digest).toContain('Cluster needs review: 1');
    expect(digest).toContain('Needs your decision:');
    expect(digest).toContain('Review: Potentially shared-team item.');
    expect(digest).toContain('Recommended: Promote to project memory unless this is approved team truth');
    expect(digest).toContain('Why shown: shared/team or policy-sensitive memory');
    expect(digest).toContain('Scope/project: ob1-memory');
    expect(digest).toContain('Debug refs: discord:1');
    expect(digest).not.toContain('Content column:');
    expect(digest).not.toContain('Raw capture candidate.');
  });

  it('alerts after repeated classifier failure cycles', () => {
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

    const digest = buildScheduledGroomingDigest(
      [],
      [],
      [],
      {
        sinceIso: '2026-04-28T00:00:00.000Z',
        generatedAtIso: '2026-04-28T04:00:00.000Z',
        channelId: 'c1',
      },
      summary,
      [],
      3,
    );

    expect(digest).toContain('Classifier alert: OB1 classifier failed 3 consecutive grooming cycles');
  });

  it('formats pending review candidates for a daily decision digest', () => {
    const digest = buildPendingReviewDigest([{
      kind: 'item',
      key: 'agent-mail:1',
      sourceRef: 'agent-mail:1',
      project: 'agent-mail',
      text: 'Sprint review approval.',
      reason: 'shared/team or policy-sensitive memory',
      recommendedAction: 'Promote to project memory unless this is approved team truth; do not promote shared_team from this digest alone.',
      proposedMemory: 'Sprint review approval.',
      evidence: [],
    }], '2026-05-05T10:00:00.000Z');

    expect(digest).toContain('OB1 memory decision digest - 2026-05-05');
    expect(digest).toContain('Pending decisions: 1');
    expect(digest).toContain('Review: Sprint review approval.');
    expect(digest).toContain('Hourly grooming continues silently');
  });

  it('includes evidence when the review summary is only a file label', () => {
    const digest = buildPendingReviewDigest([{
      kind: 'item',
      key: 'claude-hook:1',
      sourceRef: 'claude-hook:1',
      project: 'agent-runtime',
      text: 'File: /tmp/MEMORY.md',
      reason: 'shared/team or policy-sensitive memory',
      recommendedAction: 'Review manually before promoting shared_team; prefer private_agent unless this is approved team truth.',
      proposedMemory: 'File: /tmp/MEMORY.md',
      evidence: [
        'claude-hook:1\ncontent:\nFile: /tmp/MEMORY.md\nTool name: Edit\nNew string excerpt: Jeremy approved the daily digest should show actual decision content, not source IDs.',
      ],
    }], '2026-05-05T10:00:00.000Z');

    expect(digest).toContain('Review: File: /tmp/MEMORY.md');
    expect(digest).toContain('Content: File: /tmp/MEMORY.md Tool name: Edit New string excerpt: Jeremy approved the daily digest should show actual decision content, not source IDs.');
  });

  it('dedupes pending review candidates accumulated across hourly runs', () => {
    const first = {
      kind: 'item' as const,
      key: 'agent-mail:1',
      sourceRef: 'agent-mail:1',
      project: 'agent-mail',
      text: 'Old text.',
      reason: 'old reason',
      recommendedAction: 'Old action.',
      proposedMemory: 'Old text.',
      evidence: [],
    };
    const second = { ...first, text: 'New text.', proposedMemory: 'New text.' };

    expect(mergeReviewCandidates([first], [second])).toEqual([second]);
  });

  it('persists and reloads the last decision digest snapshot so replies can be applied later', () => {
    const filePath = path.join(os.tmpdir(), `last-decision-digest-${Date.now()}-${Math.round(performance.now())}.json`);
    const record: LastDecisionDigestRecord = {
      generatedAtIso: '2026-05-30T10:30:00.000Z',
      channelId: '1491979880747765810',
      count: 2,
      digestText: 'OB1 memory decision digest - 2026-05-30',
      entries: [
        { number: 1, sourceRef: 'agent-mail:1', project: 'frontdesk', kind: 'item', recommendedAction: 'Promote item to project memory.', text: 'Tom owns the AWS accounts.' },
        { number: 2, sourceRef: 'claude-prompt:2', project: 'ob1-memory', kind: 'item', recommendedAction: 'Promote item to project memory.', text: 'CloudFront cache_policy null-at-plan provider bug.' },
      ],
    };

    writeLastDecisionDigest(record, filePath);
    expect(readLastDecisionDigest(filePath)).toEqual(record);
    expect(readLastDecisionDigest(path.join(os.tmpdir(), 'missing-last-decision-digest.json'))).toBeNull();

    fs.rmSync(filePath, { force: true });
  });
});
