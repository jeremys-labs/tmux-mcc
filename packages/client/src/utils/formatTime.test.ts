import { describe, it, expect } from 'vitest';
import { formatRelativeTime } from './formatTime';

// All tests use a fixed `now` so they're deterministic regardless of when they run.
// now = 2026-03-29T22:00:00.000Z (Sunday, March 29 2026 at 10:00 PM UTC)
//       which in local time depends on the tz, but the logic uses Date methods consistently.
const NOW = new Date('2026-03-29T22:00:00.000Z').getTime();

function ago(ms: number): number {
  return NOW - ms;
}

describe('formatRelativeTime', () => {
  it('returns "just now" for < 60 seconds', () => {
    expect(formatRelativeTime(ago(30_000), NOW)).toBe('just now');
    expect(formatRelativeTime(ago(59_999), NOW)).toBe('just now');
  });

  it('returns "N min ago" for 1–59 minutes', () => {
    expect(formatRelativeTime(ago(60_000), NOW)).toBe('1 min ago');
    expect(formatRelativeTime(ago(5 * 60_000), NOW)).toBe('5 min ago');
    expect(formatRelativeTime(ago(59 * 60_000), NOW)).toBe('59 min ago');
  });

  it('returns "Today HH:MM" for same day, 60+ minutes ago', () => {
    const result = formatRelativeTime(ago(90 * 60_000), NOW);
    expect(result).toMatch(/^Today \d+:\d{2} (AM|PM)$/);
  });

  it('returns "Yesterday HH:MM" for yesterday', () => {
    const result = formatRelativeTime(ago(26 * 60 * 60_000), NOW);
    expect(result).toMatch(/^Yesterday \d+:\d{2} (AM|PM)$/);
  });

  it('returns weekday for 2–6 days ago', () => {
    const result = formatRelativeTime(ago(3 * 24 * 60 * 60_000), NOW);
    expect(result).toMatch(/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) \d+:\d{2} (AM|PM)$/);
  });

  it('returns "MMM D, HH:MM" for >= 7 days ago', () => {
    const result = formatRelativeTime(ago(10 * 24 * 60 * 60_000), NOW);
    expect(result).toMatch(/^[A-Z][a-z]+ \d+, \d+:\d{2} (AM|PM)$/);
  });
});
