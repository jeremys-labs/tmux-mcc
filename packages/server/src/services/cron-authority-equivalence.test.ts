import { describe, expect, it } from 'vitest';
import { isValidCron, matchesCron } from '../../../../../agent-supervisor/src/scheduler-fire.ts';
import { CronParseError, cronMatches, parseCron } from './cron-occurrence.js';

// dc-20260923-005 architecture decision: the fleet deliberately keeps separate cron
// implementations because mcc-tmux must not take a runtime dependency on the scheduler,
// and the stable jobs writer is materialized as one standalone file. Separate code is
// acceptable only with a control over the ACTUAL implementations. This is intentionally
// not another copied fixture corpus: it imports the executing scheduler and compares both
// grammar acceptance and occurrence behavior over boundary expressions and dates.
const expressions = [
  '* * * * *',
  '0 0 1 1 0',
  '59 23 31 12 7',
  '*/17 */5 */2 */3 */2',
  '0-59 0-23 1-31 1-12 0-7',
  '0,15,30,45 0,12,23 1,15,31 1,6,12 0,3,7',
  '',
  '0 9 *',
  '0 0 9 * * *',
  '*/0 * * * *',
  '13 0-14/2 * * *',
  '0 9 * * MON',
  '0 99 * * *',
  '0 23-9 * * *',
  '0 9 0 * *',
  '0 9 1-32 * *',
  '0 9 * 13 *',
  '0 9 * * 1,8',
];

const dates = [
  new Date(2026, 0, 1, 0, 0),
  new Date(2026, 0, 2, 5, 17),
  new Date(2026, 1, 15, 12, 30),
  new Date(2026, 2, 31, 23, 59),
  new Date(2026, 5, 7, 9, 0),
  new Date(2026, 8, 20, 15, 45),
  new Date(2026, 11, 31, 23, 59),
];

describe('fleet cron authority equivalence (dc-20260923-005)', () => {
  it.each(expressions)('agrees on grammar acceptance for %j', (expression) => {
    let mccAccepts = true;
    try {
      parseCron(expression);
    } catch (error) {
      expect(error).toBeInstanceOf(CronParseError);
      mccAccepts = false;
    }
    expect(mccAccepts).toBe(isValidCron(expression));
  });

  it.each(expressions.filter((expression) => isValidCron(expression)))(
    'agrees on every sampled occurrence for %j',
    (expression) => {
      const parsed = parseCron(expression);
      for (const date of dates) {
        expect(cronMatches(parsed, date), `${expression} at ${date.toISOString()}`)
          .toBe(matchesCron(expression, date));
      }
    },
  );
});
