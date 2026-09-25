/**
 * Cron semantics for health checks: "has this job missed a scheduled occurrence?"
 *
 * WHY THIS EXISTS (dc-20260923-004). `runtime-health.ts` decided staleness with
 * `cronPeriodMs()`, a five-shape lookup table returning an APPROXIMATE period, and flagged
 * a job when its newest artifact was older than 2x that. Two consequences, both live:
 *
 *   * An expression outside the five shapes returns null and is inserted into
 *     `staleRecurringJobs` immediately -- so "I cannot evaluate this schedule" was recorded
 *     as a defect in the JOB. On 2026-09-23 that reported `0 7 4 6 *`, the annual reminder
 *     for the day Jeremy met Alison, as a dead job.
 *   * A period is not a schedule. A job that runs at 07:00 on the 4th of June has no
 *     meaningful "period" to be 2x of.
 *
 * Staleness is a question about OCCURRENCES: a recurring job is stale when a scheduled
 * occurrence has passed (beyond a grace) with no completion after it. That is what this
 * computes, and it is deliberately NOT another approximation -- Eli's condition on the row
 * was to derive due-ness from real cron semantics rather than extend the table until the
 * annual fixture passes, because a sixth branch turns the fixture green and leaves the
 * next unrepresentable shape in exactly the same place.
 *
 * ⚠️ THIS DUPLICATES `matchesCron` IN agent-supervisor (`scheduler-fire.ts:102`). That is a
 * known, registered cost -- dc-20260923-005, owner eli -- not an oversight. The alternative
 * was designing a cross-repo shared module at speed on a same-day row, trading a known
 * duplication for an unknown coupling. Mitigation, and it is a mitigation rather than a
 * resolution: this is pinned against the scheduler's own test cases so a divergence fails
 * loudly instead of drifting quietly.
 */

/** A field that could not be parsed at all. Callers must not treat this as "no match". */
export class CronParseError extends Error {}

function expand(field: string, min: number, max: number): Set<number> {
  const out = new Set<number>();
  for (const part of field.split(',')) {
    const [rangePart, stepPart] = part.split('/');
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step <= 0) throw new CronParseError(`bad step in ${field}`);
    let lo: number;
    let hi: number;
    if (rangePart === '*') {
      lo = min; hi = max;
    } else if (rangePart.includes('-')) {
      const [a, b] = rangePart.split('-');
      lo = Number(a); hi = Number(b);
    } else {
      lo = Number(rangePart); hi = Number(rangePart);
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) {
      throw new CronParseError(`bad field ${field}`);
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

export interface CronFields {
  minute: Set<number>;
  hour: Set<number>;
  dayOfMonth: Set<number>;
  month: Set<number>;
  dayOfWeek: Set<number>;
}

export function parseCron(expr: string): CronFields {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new CronParseError(`expected 5 fields, got ${parts.length}`);
  const [mi, ho, dom, mo, dow] = parts;
  return {
    minute: expand(mi, 0, 59),
    hour: expand(ho, 0, 23),
    dayOfMonth: expand(dom, 1, 31),
    month: expand(mo, 1, 12),
    // 0 and 7 both mean Sunday in POSIX cron.
    dayOfWeek: new Set([...expand(dow, 0, 7)].map((d) => (d === 7 ? 0 : d))),
  };
}

/**
 * Day matching MIRRORS THE SCHEDULER, and deliberately DIVERGES FROM POSIX.
 *
 * POSIX cron: when both day-of-month and day-of-week are restricted, the day matches if
 * EITHER does. The scheduler does not do that -- `matchesCron` in
 * agent-supervisor/src/scheduler-fire.ts:102 ANDs all five fields unconditionally.
 *
 * This file answers "did the job miss an occurrence THE SCHEDULER WOULD HAVE FIRED", so
 * the scheduler is the authority here and POSIX is not. Eli's condition on the row says
 * exactly that: derive due-ness using the scheduler's cron semantics.
 *
 * The direction is why this is not stylistic. OR admits occurrences the scheduler never
 * fires -- for `0 9 15 * 1`, every 15th AND every Monday rather than only a 15th falling
 * on a Monday -- and every phantom occurrence becomes a "missed" one and a false stale
 * finding. That is the false population this row exists to remove, re-manufactured by the
 * fix for it.
 *
 * I wrote POSIX first. Pinning against the scheduler's own corpus surfaced it before any
 * test was written -- the dc-20260923-005 mitigation doing its job, and also its limit: it
 * proves agreement on cases someone already thought of.
 */
function dayMatches(f: CronFields, d: Date): boolean {
  // AND, mirroring the scheduler. Read the note above before changing this to POSIX.
  return f.dayOfMonth.has(d.getDate()) && f.dayOfWeek.has(d.getDay());
}

export function cronMatches(f: CronFields, d: Date): boolean {
  return f.month.has(d.getMonth() + 1)
    && dayMatches(f, d)
    && f.hour.has(d.getHours())
    && f.minute.has(d.getMinutes());
}

/**
 * The most recent scheduled occurrence at or before `now`, or null if there is none within
 * `maxLookbackDays`.
 *
 * Day-first rather than minute-first on purpose: a minute-by-minute walk over a year is
 * ~525,600 iterations per job, and at 63 jobs every five minutes that is not a health check
 * any more. Days are filtered by the date fields first, so an annual expression costs ~365
 * cheap day tests plus one 1,440-minute scan.
 */
export function lastOccurrenceBefore(
  expr: string,
  now: Date,
  maxLookbackDays = 400,
): Date | null {
  const f = parseCron(expr);
  const cursor = new Date(now.getTime());
  cursor.setSeconds(0, 0);
  for (let day = 0; day <= maxLookbackDays; day += 1) {
    const probe = new Date(cursor.getTime());
    probe.setDate(probe.getDate() - day);
    if (!f.month.has(probe.getMonth() + 1) || !dayMatches(f, probe)) continue;
    const startMinute = day === 0 ? cursor.getHours() * 60 + cursor.getMinutes() : 24 * 60 - 1;
    for (let m = startMinute; m >= 0; m -= 1) {
      const candidate = new Date(probe.getFullYear(), probe.getMonth(), probe.getDate(), Math.floor(m / 60), m % 60, 0, 0);
      if (cronMatches(f, candidate)) return candidate;
    }
  }
  return null;
}
