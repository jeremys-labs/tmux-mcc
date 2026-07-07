import { describe, expect, it } from 'vitest';
import { createBoundedIdSet } from './runtime-delivered-ids.js';

describe('createBoundedIdSet', () => {
  it('evicts the oldest settled id once the cap is exceeded', () => {
    const set = createBoundedIdSet(3);
    set.add('a');
    set.add('b');
    set.add('c');
    set.settle('a');
    set.settle('b');
    set.settle('c');
    set.add('d');
    set.settle('d');

    expect(set.has('a')).toBe(false); // oldest settled evicted
    expect(set.has('b')).toBe(true);
    expect(set.has('c')).toBe(true);
    expect(set.has('d')).toBe(true);
    expect(set.size).toBe(3);
  });

  it('does not evict a still-queued (unsettled) id even when it is the oldest', () => {
    const set = createBoundedIdSet(3);
    set.add('oldest-queued'); // in flight, never acked
    set.add('b');
    set.add('c');
    set.settle('b');
    set.settle('c');

    // Adding a fourth id pushes over the cap. Only settled ids are eviction candidates,
    // so the oldest *settled* id ('b') is evicted — never the in-flight 'oldest-queued'.
    set.add('d');
    set.settle('d');

    expect(set.has('oldest-queued')).toBe(true);
    expect(set.has('b')).toBe(false);
    expect(set.has('c')).toBe(true);
    expect(set.has('d')).toBe(true);
  });

  it('temporarily exceeds the cap rather than evict an in-flight id', () => {
    const set = createBoundedIdSet(2);
    set.add('a');
    set.add('b');
    set.add('c'); // over cap, but all three are in flight → nothing evicted

    expect(set.size).toBe(3);
    expect(set.has('a')).toBe(true);
    expect(set.has('b')).toBe(true);
    expect(set.has('c')).toBe(true);

    // Once two settle, the next settle can bring it back to the cap.
    set.settle('a');
    set.settle('b');
    expect(set.size).toBe(2);
    expect(set.has('c')).toBe(true); // still in flight, retained
  });

  it('delete drops the id from both membership and the eviction queue', () => {
    const set = createBoundedIdSet(3);
    set.add('a');
    set.settle('a');
    expect(set.delete('a')).toBe(true);
    expect(set.has('a')).toBe(false);
    expect(set.size).toBe(0);
  });
});
