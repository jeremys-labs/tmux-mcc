import { describe, expect, it } from 'vitest';
import {
  canSearchRestrictedCellebrite,
  filterRestrictedRows,
  hasCellebritePrefix,
  shouldRestrictCellebriteCapture,
  stripCellebritePrefix,
} from './open-brain-restrictions.js';

describe('open brain restricted memory policy', () => {
  it('detects Cellebrite prefix and strips only the routing marker', () => {
    expect(hasCellebritePrefix('Cellebrite — case update')).toBe(true);
    expect(hasCellebritePrefix('Cellebrite -- case update')).toBe(true);
    expect(stripCellebritePrefix('Cellebrite — case update')).toBe('case update');
  });

  it('uses a configured channel id as the primary restricted trigger', () => {
    expect(shouldRestrictCellebriteCapture({
      content: 'case update',
      channelId: '1511056290569519236',
      restrictedChannelIds: new Set(['1511056290569519236']),
    })).toBe(true);
  });

  it('allows restricted recall only for Isla on Cellebrite-marked turns', () => {
    expect(canSearchRestrictedCellebrite({
      agentKey: 'isla',
      text: 'Use Cellebrite context.',
      channelId: 'hq',
      restrictedChannelIds: new Set(['private']),
    })).toBe(true);
    expect(canSearchRestrictedCellebrite({
      agentKey: 'eli',
      text: 'Use Cellebrite context.',
      channelId: 'hq',
      restrictedChannelIds: new Set(['private']),
    })).toBe(false);
  });

  it('gives newsletter, A2A, shared-topic, and team-digest exporters a common deny filter', () => {
    const rows = [
      { metadata: { scope: 'project', project: 'newsletter' }, content: 'newsletter-safe' },
      { metadata: { scope: 'restricted', restriction: 'cellebrite' }, content: 'do-not-export' },
    ];

    const visible = filterRestrictedRows(rows);

    expect(visible).toHaveLength(1);
    expect(visible[0]?.content).toBe('newsletter-safe');
  });
});
