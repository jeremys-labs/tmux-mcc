const DOW_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function formatTime12(hour: number, minute: number): string {
  const period = hour < 12 ? 'AM' : 'PM';
  const h = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
  const m = minute === 0 ? '' : `:${String(minute).padStart(2, '0')}`;
  return `${h}${m} ${period}`;
}

export function formatCronExpr(expr: string): string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return expr;
  const [min, hour, dom, month, dow] = parts;

  if (expr === '* * * * *') return 'Every minute';

  if (min.startsWith('*/') && hour === '*' && dom === '*' && month === '*' && dow === '*') {
    const n = parseInt(min.slice(2), 10);
    if (!isNaN(n) && n > 1) return `Every ${n} minutes`;
  }

  if (min === '0' && hour.startsWith('*/') && dom === '*' && month === '*' && dow === '*') {
    const n = parseInt(hour.slice(2), 10);
    if (!isNaN(n) && n > 1) return `Every ${n} hours`;
  }

  const m = parseInt(min, 10);
  const h = parseInt(hour, 10);
  if (isNaN(m) || isNaN(h) || dom !== '*' || month !== '*') return expr;

  const timeStr = formatTime12(h, m);

  if (dow === '*') return `Daily at ${timeStr}`;
  if (dow === '1-5') return `Weekdays at ${timeStr}`;
  if (dow === '0,6' || dow === '6,0') return `Weekends at ${timeStr}`;

  const dowNum = parseInt(dow, 10);
  if (!isNaN(dowNum) && dowNum >= 0 && dowNum <= 6) {
    return `${DOW_NAMES[dowNum]}s at ${timeStr}`;
  }

  return expr;
}

export interface CronSchedule {
  kind: string;
  expr?: string;
  tz?: string;
  everyMs?: number;
}

export function formatCronSchedule(s: CronSchedule): string {
  if (s.kind === 'cron' && s.expr) {
    const human = formatCronExpr(s.expr);
    return s.tz && human !== s.expr ? `${human} (${s.tz})` : human;
  }
  if (s.kind === 'every' && s.everyMs) {
    const ms = s.everyMs;
    if (ms < 60_000) return `Every ${Math.round(ms / 1000)}s`;
    if (ms < 3_600_000) return `Every ${Math.round(ms / 60_000)}m`;
    if (ms < 86_400_000) return `Every ${Math.round(ms / 3_600_000)}h`;
    return `Every ${Math.round(ms / 86_400_000)}d`;
  }
  return s.kind;
}

export function formatRelativeMs(ms: number, now = Date.now()): string {
  const diff = ms - now;
  const abs = Math.abs(diff);
  const future = diff > 0;
  if (abs < 60_000) return future ? 'in <1m' : '<1m ago';
  if (abs < 3_600_000) {
    const m = Math.round(abs / 60_000);
    return future ? `in ${m}m` : `${m}m ago`;
  }
  if (abs < 86_400_000) {
    const h = Math.round(abs / 3_600_000);
    return future ? `in ${h}h` : `${h}h ago`;
  }
  const d = Math.round(abs / 86_400_000);
  return future ? `in ${d}d` : `${d}d ago`;
}
