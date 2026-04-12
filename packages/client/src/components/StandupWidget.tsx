import { useEffect } from 'react';
import { useStandupStore } from '../stores/standupStore';
import { useAgentStore } from '../stores/agentStore';

function formatStandupDate(raw: string | null): string {
  if (!raw) return 'No data';
  // Parse YYYY-MM-DD as local time (new Date("2026-03-02") parses as UTC, causing off-by-one)
  const parts = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const parsed = parts
    ? new Date(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]))
    : new Date(raw);
  if (isNaN(parsed.getTime())) return raw;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dateDay = new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate());
  const diffDays = Math.round((today.getTime() - dateDay.getTime()) / 86400000);
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  return parsed.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

export function StandupWidget() {
  const { date, agents: standupAgents, loading, fetch: fetchStandup } = useStandupStore();
  const agents = useAgentStore((s) => s.agents);

  useEffect(() => {
    fetchStandup();
    const interval = setInterval(fetchStandup, 60000);
    return () => clearInterval(interval);
  }, [fetchStandup]);

  if (loading) return null;

  const completed = Object.values(standupAgents).filter((a) => a.status === 'completed').length;
  const total = Object.keys(standupAgents).length;

  return (
    <div className="bg-surface-raised rounded-lg border border-white/10 p-3">
      <div className="flex items-center justify-between gap-2 mb-2">
        <h3 className="text-xs font-semibold text-text-secondary uppercase tracking-wide">Standup</h3>
        <span className="text-xs text-text-secondary">{formatStandupDate(date)}</span>
      </div>
      {total > 0 && (
        <div className="text-sm mb-2">{completed}/{total} completed</div>
      )}
      <div className="space-y-1.5">
        {Object.entries(standupAgents).map(([key, standup]) => {
          const agent = agents[key];
          return (
            <details key={key} className="group">
              <summary className="flex items-center gap-2 cursor-pointer text-sm hover:text-text-primary list-none">
                <span
                  className={`w-2 h-2 rounded-full shrink-0 ${
                    standup.status === 'completed'
                      ? 'bg-green-500'
                      : standup.status === 'blocked'
                        ? 'bg-red-500'
                        : 'bg-yellow-500'
                  }`}
                />
                <span>{agent?.emoji}</span>
                <span className="text-text-secondary">{agent?.name || key}</span>
              </summary>
              <div className="ml-6 mt-1 text-xs text-text-secondary space-y-1">
                {standup.today && <div><strong>Working on:</strong> {standup.today}</div>}
                {standup.blockers && <div className="text-red-400"><strong>Blockers:</strong> {standup.blockers}</div>}
                {standup.learned && <div className="text-blue-400"><strong>Learned:</strong> {standup.learned}</div>}
              </div>
            </details>
          );
        })}
      </div>
    </div>
  );
}
