/**
 * Format a timestamp (ms since epoch) as a human-readable relative label.
 *
 * Returns strings like:
 *   "just now"          — less than 60 seconds ago
 *   "5 min ago"         — less than 60 minutes ago
 *   "Today 3:42 PM"     — today
 *   "Yesterday 9:15 AM" — yesterday
 *   "Mon 3:42 PM"       — within the last 7 days
 *   "Mar 22, 3:42 PM"   — older
 */
export function formatRelativeTime(ts: number, now = Date.now()): string {
  const diffMs = now - ts;
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);

  if (diffSec < 60) return 'just now';
  if (diffMin < 60) return `${diffMin} min ago`;

  const date = new Date(ts);
  const nowDate = new Date(now);
  const today = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate());
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const msgDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());

  const timeStr = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

  if (msgDay.getTime() === today.getTime()) {
    return `Today ${timeStr}`;
  }
  if (msgDay.getTime() === yesterday.getTime()) {
    return `Yesterday ${timeStr}`;
  }

  const diffDays = Math.floor(diffMs / 86_400_000);
  if (diffDays < 7) {
    const weekday = date.toLocaleDateString(undefined, { weekday: 'short' });
    return `${weekday} ${timeStr}`;
  }

  const dateLabel = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `${dateLabel}, ${timeStr}`;
}

/**
 * Format a timestamp as a precise tooltip string.
 */
export function formatPreciseTime(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  });
}
