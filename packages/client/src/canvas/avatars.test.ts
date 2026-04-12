import { describe, it, expect } from 'vitest';
import { buildAvatarOptions } from './avatars.js';

describe('buildAvatarOptions', () => {
  it('returns role defaults when no avatar override provided', () => {
    const opts = buildAvatarOptions('research', undefined);
    expect(opts.glasses).toEqual(['dark01']);
    expect(opts.glassesProbability).toBe(100);
  });

  it('agent avatar overrides role defaults', () => {
    const opts = buildAvatarOptions('dev manager', {
      accessories: ['variant01'],
      accessoriesProbability: 100,
    });
    // role default is accessories variant02 — agent overrides to variant01
    expect(opts.accessories).toEqual(['variant01']);
    expect(opts.accessoriesProbability).toBe(100);
  });

  it('agent avatar can add fields not in role defaults', () => {
    const opts = buildAvatarOptions('research', {
      hair: ['short05'],
      beardProbability: 100,
    });
    // role adds glasses, agent adds hair + beard
    expect(opts.glasses).toEqual(['dark01']);
    expect(opts.hair).toEqual(['short05']);
    expect(opts.beardProbability).toBe(100);
  });

  it('returns empty object for unknown role with no avatar override', () => {
    const opts = buildAvatarOptions('unknown', undefined);
    expect(opts).toEqual({});
  });

  it('returns agent avatar opts for unknown role', () => {
    const opts = buildAvatarOptions('unknown', { hair: ['long03'] });
    expect(opts.hair).toEqual(['long03']);
  });
});
