import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  formatGroomingDecisionStatus,
  formatLastDecisionDigestList,
  readCurrentDecisionRecord,
  selectDecisionEntries,
} from './open-brain-grooming-decisions.js';
import type { LastDecisionDigestRecord } from './open-brain-grooming-digest.js';

function record(): LastDecisionDigestRecord {
  return {
    generatedAtIso: '2026-06-04T20:00:00.000Z',
    channelId: '1491979880747765810',
    count: 4,
    digestText: 'digest',
    entries: [
      { number: 1, sourceRef: 'discord:1', project: 'agent-runtime', kind: 'item', recommendedAction: 'Ignore.', text: 'Transient.' },
      { number: 2, sourceRef: 'discord:2', project: 'frontdesk', kind: 'item', recommendedAction: 'Promote project.', text: 'FrontDesk decision.' },
      { number: 3, sourceRef: 'discord:3, discord:4', project: 'ob1-memory', kind: 'cluster', recommendedAction: 'Promote cluster.', text: 'OB1 memory policy.' },
      { number: 4, sourceRef: 'agent-mail:5', project: 'agent-mail', kind: 'item', recommendedAction: 'Deprecate.', text: 'Deprecated note.' },
    ],
  };
}

describe('open brain grooming decisions', () => {
  it('formats decision status for operator dashboards and CLI output', () => {
    expect(formatGroomingDecisionStatus({
      pendingReviewCount: 3,
      lastDecisionDigestIso: '2026-06-04T19:00:00.000Z',
      lastDigestCount: 4,
      lastDigestGeneratedAtIso: '2026-06-04T20:00:00.000Z',
    })).toContain('Pending state queue: 3');
  });

  it('formats the last decision digest with numbers, refs, and recommendations', () => {
    const text = formatLastDecisionDigestList(record());
    expect(text).toContain('#2 [item] frontdesk');
    expect(text).toContain('Refs: discord:2');
    expect(text).toContain('Recommended: Promote project.');
  });

  it('can build a decision record from pending state candidates when no digest snapshot exists', () => {
    const previousState = process.env.OPEN_BRAIN_GROOMING_DIGEST_STATE;
    const previousDigest = process.env.OPEN_BRAIN_LAST_DECISION_DIGEST;
    const statePath = `/tmp/ob1-grooming-state-${Date.now()}-${Math.round(performance.now())}.json`;
    const digestPath = `/tmp/ob1-missing-decision-digest-${Date.now()}-${Math.round(performance.now())}.json`;
    process.env.OPEN_BRAIN_GROOMING_DIGEST_STATE = statePath;
    process.env.OPEN_BRAIN_LAST_DECISION_DIGEST = digestPath;
    try {
      fs.writeFileSync(statePath, JSON.stringify({
        lastDecisionDigestIso: '2026-06-04T20:00:00.000Z',
        pendingReviewCandidates: [{
          kind: 'item',
          key: 'discord:1',
          sourceRef: 'discord:1',
          project: 'agent-runtime',
          text: 'Review me.',
          reason: 'needs review',
          recommendedAction: 'Promote if durable.',
          proposedMemory: 'Review me.',
          evidence: [],
        }],
      }));

      const pending = readCurrentDecisionRecord();
      expect(pending?.entries).toEqual([{
        number: 1,
        sourceRef: 'discord:1',
        project: 'agent-runtime',
        kind: 'item',
        recommendedAction: 'Promote if durable.',
        text: 'Review me.',
      }]);
    } finally {
      fs.rmSync(statePath, { force: true });
      if (previousState === undefined) delete process.env.OPEN_BRAIN_GROOMING_DIGEST_STATE;
      else process.env.OPEN_BRAIN_GROOMING_DIGEST_STATE = previousState;
      if (previousDigest === undefined) delete process.env.OPEN_BRAIN_LAST_DECISION_DIGEST;
      else process.env.OPEN_BRAIN_LAST_DECISION_DIGEST = previousDigest;
    }
  });

  it('selects numbered decisions by single number, range, comma list, or all', () => {
    expect(selectDecisionEntries(record(), '2').map((entry) => entry.number)).toEqual([2]);
    expect(selectDecisionEntries(record(), '2-3').map((entry) => entry.number)).toEqual([2, 3]);
    expect(selectDecisionEntries(record(), '1, 3-4').map((entry) => entry.number)).toEqual([1, 3, 4]);
    expect(selectDecisionEntries(record(), 'all').map((entry) => entry.number)).toEqual([1, 2, 3, 4]);
  });

  it('rejects invalid selectors before any live OB1 mutation', () => {
    expect(() => selectDecisionEntries(record(), '0')).toThrow('Invalid decision number');
    expect(() => selectDecisionEntries(record(), '4-2')).toThrow('Invalid decision range');
    expect(() => selectDecisionEntries(record(), '')).toThrow('Missing decision selector');
  });
});
