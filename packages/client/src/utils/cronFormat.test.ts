import { describe, it, expect } from 'vitest';
import { formatCronExpr, formatCronSchedule, formatRelativeMs } from './cronFormat';

describe('formatCronExpr', () => {
  it('every minute', () => {
    expect(formatCronExpr('* * * * *')).toBe('Every minute');
  });

  it('every N minutes', () => {
    expect(formatCronExpr('*/15 * * * *')).toBe('Every 15 minutes');
    expect(formatCronExpr('*/5 * * * *')).toBe('Every 5 minutes');
  });

  it('every N hours', () => {
    expect(formatCronExpr('0 */2 * * *')).toBe('Every 2 hours');
    expect(formatCronExpr('0 */6 * * *')).toBe('Every 6 hours');
  });

  it('daily at time', () => {
    expect(formatCronExpr('0 9 * * *')).toBe('Daily at 9 AM');
    expect(formatCronExpr('30 14 * * *')).toBe('Daily at 2:30 PM');
    expect(formatCronExpr('0 0 * * *')).toBe('Daily at 12 AM');
  });

  it('weekdays', () => {
    expect(formatCronExpr('5 7 * * 1-5')).toBe('Weekdays at 7:05 AM');
    expect(formatCronExpr('0 18 * * 1-5')).toBe('Weekdays at 6 PM');
  });

  it('weekends', () => {
    expect(formatCronExpr('0 10 * * 0,6')).toBe('Weekends at 10 AM');
    expect(formatCronExpr('0 10 * * 6,0')).toBe('Weekends at 10 AM');
  });

  it('single day of week', () => {
    expect(formatCronExpr('0 9 * * 1')).toBe('Mondays at 9 AM');
    expect(formatCronExpr('0 9 * * 0')).toBe('Sundays at 9 AM');
    expect(formatCronExpr('0 9 * * 5')).toBe('Fridays at 9 AM');
  });

  it('falls back to raw expr for unrecognised patterns', () => {
    expect(formatCronExpr('0 9 1 * *')).toBe('0 9 1 * *');
    expect(formatCronExpr('0 9 * 6 *')).toBe('0 9 * 6 *');
    expect(formatCronExpr('not a cron')).toBe('not a cron');
  });
});

describe('formatCronSchedule', () => {
  it('formats cron kind', () => {
    expect(formatCronSchedule({ kind: 'cron', expr: '5 7 * * 1-5' })).toBe('Weekdays at 7:05 AM');
  });

  it('appends tz for cron when expr was transformed', () => {
    expect(formatCronSchedule({ kind: 'cron', expr: '5 7 * * 1-5', tz: 'America/New_York' }))
      .toBe('Weekdays at 7:05 AM (America/New_York)');
  });

  it('does not append tz when expr was not recognised (raw passthrough)', () => {
    expect(formatCronSchedule({ kind: 'cron', expr: '0 9 1 * *', tz: 'UTC' })).toBe('0 9 1 * *');
  });

  it('formats every kind', () => {
    expect(formatCronSchedule({ kind: 'every', everyMs: 3_600_000 })).toBe('Every 1h');
    expect(formatCronSchedule({ kind: 'every', everyMs: 300_000 })).toBe('Every 5m');
  });
});

describe('formatRelativeMs', () => {
  const NOW = 1_000_000_000;

  it('future times', () => {
    expect(formatRelativeMs(NOW + 30_000, NOW)).toBe('in <1m');
    expect(formatRelativeMs(NOW + 5 * 60_000, NOW)).toBe('in 5m');
    expect(formatRelativeMs(NOW + 9 * 3_600_000, NOW)).toBe('in 9h');
    expect(formatRelativeMs(NOW + 2 * 86_400_000, NOW)).toBe('in 2d');
  });

  it('past times', () => {
    expect(formatRelativeMs(NOW - 5 * 60_000, NOW)).toBe('5m ago');
    expect(formatRelativeMs(NOW - 2 * 3_600_000, NOW)).toBe('2h ago');
  });
});
