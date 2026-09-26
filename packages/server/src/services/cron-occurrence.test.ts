import { describe, expect, it } from 'vitest';
import { CronParseError, lastOccurrenceBefore, cronMatches, parseCron } from './cron-occurrence.js';

// THE SHARED CORPUS. These are agent-supervisor's own matchesCron cases
// (scheduler-fire.test.ts:20-28), reproduced verbatim.
//
// This is the accepted MITIGATION for dc-20260923-005 — cron semantics now exist in two
// repos — and not a resolution. It proves agreement on cases someone already thought of,
// which is exactly the class of assurance this row exists because nobody had. Its value is
// already demonstrated: it caught a real divergence before any of these were written.
describe('agrees with the scheduler it is standing in for', () => {
  const m = (expr: string, d: Date) => cronMatches(parseCron(expr), d);

  it('matches the scheduler on its own corpus', () => {
    expect(m('0 9 * * *', new Date(2026, 5, 7, 9, 0))).toBe(true);
    expect(m('0 9 * * *', new Date(2026, 5, 7, 9, 1))).toBe(false);
    expect(m('*/15 * * * *', new Date(2026, 5, 7, 9, 30))).toBe(true);
    expect(m('*/15 * * * *', new Date(2026, 5, 7, 9, 31))).toBe(false);
    expect(m('0 9-17 * * *', new Date(2026, 5, 7, 12, 0))).toBe(true);
    expect(m('0 9 * * 1,3,5', new Date(2026, 5, 5, 9, 0))).toBe(true); // Friday
  });

  it('ANDs day-of-month with day-of-week, as the scheduler does and POSIX does not', () => {
    // I wrote POSIX (either-matches) first. The scheduler ANDs all five fields, and this
    // asks "did the job miss an occurrence THE SCHEDULER would have fired" -- so the
    // scheduler is the authority. The direction is the point: OR admits occurrences that
    // never fire, and each phantom becomes a missed occurrence and a FALSE STALE FINDING,
    // which is this row's own false population re-manufactured by its fix.
    //
    // 2026-06-15 is a Monday. Under AND both must hold, so a 15th that is a Monday matches
    // and an ordinary Monday does not.
    expect(m('0 9 15 * 1', new Date(2026, 5, 15, 9, 0))).toBe(true);
    expect(m('0 9 15 * 1', new Date(2026, 5, 22, 9, 0))).toBe(false); // Monday, not the 15th
    expect(m('0 9 15 * 1', new Date(2026, 6, 15, 9, 0))).toBe(false); // 15th, not a Monday
  });

  it('does not normalize day-of-week 7 to Sunday because the scheduler does not', () => {
    expect(m('0 9 * * 7', new Date(2026, 5, 7, 9, 0))).toBe(false); // Sunday
  });

  it('rejects compound field forms the scheduler rejects', () => {
    expect(() => parseCron('0 9 * * 1-3,5')).toThrow(CronParseError);
    expect(() => parseCron('0 9 * * 1-5/2')).toThrow(CronParseError);
  });

  it('refuses an expression it cannot parse instead of reporting no-match', () => {
    // A parse failure and "this minute does not match" must never be the same answer: one
    // is the checker's limit and the other is a fact about the schedule.
    expect(() => parseCron('0 9 *')).toThrow(CronParseError);
    expect(() => parseCron('0 99 * * *')).toThrow(CronParseError);
    expect(() => parseCron('*/0 * * * *')).toThrow(CronParseError);
  });
});

describe('last scheduled occurrence', () => {
  it('resolves the seasonal month-lists the old table could not read', () => {
    // 13 of the 14 "unevaluable" jobs were Hank's, all correct crons the checker could not
    // read. cronPeriodMs returned null and that null was filed as a fault in the job.
    const now = new Date(2026, 8, 24, 18, 0); // 2026-09-24 18:00 local
    expect(lastOccurrenceBefore('0 9 1 1,4,7,10 *', now)?.toISOString().slice(0, 10)).toBe('2026-07-01');
    expect(lastOccurrenceBefore('0 6 1 1,7 *', now)?.toISOString().slice(0, 10)).toBe('2026-07-01');
  });

  it('resolves an annual expression to its real occurrence, not to null', () => {
    const now = new Date(2026, 8, 24, 18, 0);
    const last = lastOccurrenceBefore('0 7 4 6 *', now);
    expect(last?.toISOString().slice(0, 10)).toBe('2026-06-04');
  });

  it('returns null when nothing was due in the lookback, rather than guessing', () => {
    // A February-29 schedule has no occurrence inside a 400-day window ending 2026-09-24.
    expect(lastOccurrenceBefore('0 9 29 2 *', new Date(2026, 8, 24, 18, 0), 400)).toBeNull();
  });

  it('is bounded — an annual schedule costs days scanned, not minutes in a year', () => {
    // Day-first on purpose: minute-first over a year is ~525,600 iterations per job, and at
    // 63 jobs every five minutes that is not a health check any more.
    const start = Date.now();
    lastOccurrenceBefore('0 7 4 6 *', new Date(2026, 8, 24, 18, 0));
    expect(Date.now() - start).toBeLessThan(500);
  });
});
