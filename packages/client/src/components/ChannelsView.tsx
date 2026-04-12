import { useEffect, useMemo, useState } from 'react';
import { useChannelStore } from '../stores/channelStore';
import { formatPreciseTime, formatRelativeTime } from '../utils/formatTime';

export function ChannelsView() {
  const interactions = useChannelStore((s) => s.interactions);
  const loading = useChannelStore((s) => s.loading);
  const fetchInteractions = useChannelStore((s) => s.fetch);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    void fetchInteractions();
  }, [fetchInteractions]);

  const filteredInteractions = useMemo(() => {
    const query = filter.trim().toLowerCase();
    const sorted = [...interactions].sort((a, b) => b.timestamp - a.timestamp);
    if (!query) return sorted;
    return sorted.filter((interaction) =>
      [interaction.from, interaction.to, interaction.content, interaction.type]
        .filter(Boolean)
        .some((value) => value!.toLowerCase().includes(query))
    );
  }, [filter, interactions]);

  return (
    <div className="flex h-full flex-col overflow-hidden bg-surface px-4 py-4 md:px-6">
      <div className="mb-4 flex flex-col gap-3 border-b border-white/10 pb-4 md:flex-row md:items-end md:justify-between">
        <div>
          <div className="mb-1 text-3xl">💬</div>
          <h2 className="text-lg font-semibold text-text-primary">Agent Channels</h2>
          <p className="mt-1 max-w-2xl text-sm text-text-secondary">
            See how agents are coordinating across the office, including handoffs, reviews, and status updates.
          </p>
        </div>
        <div className="w-full md:max-w-sm">
          <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-text-secondary">
            Filter interactions
          </label>
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter interactions..."
            className="w-full rounded-lg border border-white/10 bg-surface-input px-3 py-2 text-sm focus:outline-none focus:border-white/30 focus:ring-1 focus:ring-white/20"
          />
        </div>
      </div>

      {loading ? (
        <div className="flex flex-1 items-center justify-center text-sm text-text-secondary">Loading recent channel activity...</div>
      ) : filteredInteractions.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
          <div className="mb-3 text-4xl">📭</div>
          <h3 className="text-base font-semibold text-text-primary">No recent agent interactions yet</h3>
          <p className="mt-2 max-w-md text-sm text-text-secondary">
            When agents start coordinating, handoffs and updates will appear here automatically.
          </p>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto pr-1">
          <div className="mb-3 text-xs text-text-secondary">
            Showing {filteredInteractions.length} recent interaction{filteredInteractions.length === 1 ? '' : 's'}
          </div>
          <div className="space-y-3">
            {filteredInteractions.map((interaction, index) => (
              <article
                key={`${interaction.from}-${interaction.to}-${interaction.timestamp}-${index}`}
                className="rounded-2xl border border-white/10 bg-surface-raised p-4 shadow-sm"
              >
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-semibold text-text-primary">{interaction.from}</span>
                  <span className="text-text-secondary">→</span>
                  <span className="font-semibold text-text-primary">{interaction.to}</span>
                  {interaction.type ? (
                    <span className="rounded-full bg-accent/10 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-accent">
                      {interaction.type}
                    </span>
                  ) : null}
                  <span
                    className="ml-auto text-xs text-text-secondary"
                    title={formatPreciseTime(interaction.timestamp)}
                  >
                    {formatRelativeTime(interaction.timestamp)}
                  </span>
                </div>
                <p className="mt-3 text-sm leading-6 text-text-primary">{interaction.content}</p>
              </article>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
