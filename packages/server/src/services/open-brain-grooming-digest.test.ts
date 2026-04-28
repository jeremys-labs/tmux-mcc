import { describe, expect, it } from 'vitest';
import { buildGroomingDigest, defaultSinceIso, type RawCaptureRow } from './open-brain-grooming-digest.js';

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
});
