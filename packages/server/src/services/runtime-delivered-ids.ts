/** Upper bound on each channel's delivered-id dedup set on long-lived panes. */
export const DEFAULT_DELIVERED_ID_CAP = 5_000;

/**
 * Dedup set for in-flight and delivered message ids, shared by the inbox pollers and the
 * per-channel enqueuers. `add` marks an id as in-flight (pinned); `settle` marks a delivery as
 * complete (acked) and therefore safe to evict. Only settled ids are eviction candidates, so a
 * still-queued/unacked id is never dropped — dropping it would let the next poll re-enqueue a
 * duplicate. A plain `Set<string>` is structurally assignable to this type (settle optional),
 * so tests that don't care about eviction can still pass a bare Set.
 */
export interface DeliveredIdSet {
  has(id: string): boolean;
  add(id: string): void;
  delete(id: string): boolean;
  /** Mark a delivered (acked) id as safe to evict. No-op for ids not currently tracked. */
  settle?(id: string): void;
  readonly size: number;
}

/**
 * A {@link DeliveredIdSet} that evicts its oldest *settled* entry once membership exceeds `max`.
 * If the set is over `max` but every entry is still in flight, nothing is evicted (the cap is
 * exceeded until a delivery settles) — an in-flight id is never sacrificed to the cap.
 */
export function createBoundedIdSet(max: number): DeliveredIdSet {
  const members = new Set<string>();
  const settled = new Set<string>(); // insertion order = eviction order

  const evictIfNeeded = () => {
    while (members.size > max && settled.size > 0) {
      const oldest = settled.values().next().value as string;
      settled.delete(oldest);
      members.delete(oldest);
    }
  };

  return {
    has: (id) => members.has(id),
    add: (id) => {
      members.add(id);
      evictIfNeeded();
    },
    delete: (id) => {
      settled.delete(id);
      return members.delete(id);
    },
    settle: (id) => {
      if (!members.has(id)) return;
      settled.add(id);
      evictIfNeeded();
    },
    get size() {
      return members.size;
    },
  };
}
