import { useEffect, useState } from 'react';
import { useAgentStore } from '../stores/agentStore';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkFrontmatter from 'remark-frontmatter';
import { CronDetailPanel } from './CronDetailPanel';

interface Props {
  agentKey: string;
}

// ---------------------------------------------------------------------------
// Status badge colors
// ---------------------------------------------------------------------------

const STATUS_COLORS: Record<string, string> = {
  complete: 'bg-green-500/20 text-green-400',
  completed: 'bg-green-500/20 text-green-400',
  merged: 'bg-green-500/20 text-green-400',
  approved: 'bg-green-500/20 text-green-400',
  'on track': 'bg-green-500/20 text-green-400',
  active: 'bg-blue-500/20 text-blue-400',
  'in progress': 'bg-blue-500/20 text-blue-400',
  investigating: 'bg-yellow-500/20 text-yellow-400',
  planning: 'bg-yellow-500/20 text-yellow-400',
  planned: 'bg-yellow-500/20 text-yellow-400',
  scheduled: 'bg-yellow-500/20 text-yellow-400',
  pending: 'bg-yellow-500/20 text-yellow-400',
  open: 'bg-orange-500/20 text-orange-400',
  backlog: 'bg-gray-500/20 text-gray-400',
};

function StatusBadge({ status }: { status: string }) {
  const colorClass = STATUS_COLORS[status.toLowerCase()] || 'bg-gray-500/20 text-gray-400';
  return (
    <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${colorClass}`}>
      {status}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Priority indicator
// ---------------------------------------------------------------------------

const PRIORITY_COLORS: Record<string, string> = {
  high: 'text-red-400',
  medium: 'text-yellow-400',
  low: 'text-gray-400',
  critical: 'text-red-500',
};

// ---------------------------------------------------------------------------
// Smart JSON renderer — cards for arrays, key-value for objects
// ---------------------------------------------------------------------------

function findTitle(obj: Record<string, unknown>): string {
  for (const key of ['title', 'name', 'item', 'type', 'day']) {
    if (typeof obj[key] === 'string') return obj[key] as string;
  }
  return '';
}

function findSubtitle(obj: Record<string, unknown>): string | null {
  for (const key of ['repo', 'channel', 'focus', 'assignee', 'reporter', 'author', 'lead']) {
    if (typeof obj[key] === 'string') return obj[key] as string;
  }
  return null;
}

const SKIP_KEYS = new Set(['id', 'title', 'name', 'item', 'type', 'status', 'priority', 'severity', 'repo', 'channel', 'focus', 'assignee', 'reporter', 'author', 'lead', 'day']);

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function formatDate(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const currentYear = new Date().getFullYear();
  if (y === currentYear) {
    return date.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
  }
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(v => formatValue(v)).join(', ');
  if (typeof value === 'number') return value.toLocaleString();
  if (typeof value === 'string' && ISO_DATE_RE.test(value)) return formatDate(value);
  if (value != null && typeof value === 'object') {
    const entries = Object.values(value as Record<string, unknown>);
    return entries.map(v => formatValue(v)).join(' · ');
  }
  return String(value ?? '');
}

function formatLabel(key: string): string {
  return key.replace(/([A-Z])/g, ' $1').replace(/[_-]/g, ' ').replace(/^\w/, c => c.toUpperCase());
}

interface HeadlineItem {
  title: string;
  url: string;
  type?: string;
}

const HEADLINE_SKIP_KEYS = new Set([...Array.from(new Set(['id', 'title', 'name', 'item', 'type', 'status', 'priority', 'severity', 'repo', 'channel', 'focus', 'assignee', 'reporter', 'author', 'lead', 'day'])), 'headlines', 'latest', 'summary']);

function CardItem({ obj, onSelect }: { obj: Record<string, unknown>; onSelect?: (id: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const title = findTitle(obj);
  const subtitle = findSubtitle(obj);
  const status = typeof obj.status === 'string' ? obj.status : null;
  const priority = typeof obj.priority === 'string' ? obj.priority : null;
  const severity = typeof obj.severity === 'string' ? obj.severity : null;
  const id = obj.id != null ? String(obj.id) : null;
  const headlines = Array.isArray(obj.headlines) ? (obj.headlines as HeadlineItem[]) : null;
  const summary = typeof obj.summary === 'string' ? obj.summary : null;

  const extraFields = Object.entries(obj).filter(
    ([k, v]) => !HEADLINE_SKIP_KEYS.has(k) && !SKIP_KEYS.has(k) && v != null && v !== '',
  );

  const handleExpand = (e: React.MouseEvent) => {
    e.stopPropagation();
    setExpanded(prev => !prev);
  };

  return (
    <div
      className={`border border-white/10 rounded-lg p-3 transition-colors ${onSelect ? 'cursor-pointer hover:border-accent/50 hover:bg-accent/5' : 'hover:border-white/20'}`}
      onClick={onSelect && id ? () => onSelect(id) : undefined}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {id && <span className="text-[10px] text-text-secondary font-mono shrink-0">{id}</span>}
            {(priority || severity) && (
              <span className={`text-[10px] font-medium ${PRIORITY_COLORS[(priority || severity || '').toLowerCase()] || 'text-gray-400'}`}>
                {priority || severity}
              </span>
            )}
          </div>
          <div className="text-sm text-text-primary mt-0.5">{title}</div>
          {subtitle && <div className="text-xs text-text-secondary mt-0.5">{subtitle}</div>}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {status && <StatusBadge status={status} />}
          {headlines && headlines.length > 0 && (
            <button
              onClick={handleExpand}
              className="text-[10px] text-text-secondary hover:text-accent transition-colors px-1.5 py-0.5 rounded border border-white/10 hover:border-accent/40"
            >
              {expanded ? '▲ Hide' : `▼ ${headlines.length} items`}
            </button>
          )}
        </div>
      </div>
      {summary && (
        <div className="mt-2 pt-2 border-t border-white/5">
          <p className="text-[11px] text-text-secondary leading-relaxed">{summary}</p>
        </div>
      )}
      {extraFields.length > 0 && (
        <div className="mt-2 pt-2 border-t border-white/5 grid grid-cols-2 gap-x-3 gap-y-1">
          {extraFields.map(([k, v]) => (
            <div key={k} className="text-[11px]">
              <span className="text-text-secondary">{formatLabel(k)}: </span>
              <span className="text-text-primary">{formatValue(v)}</span>
            </div>
          ))}
        </div>
      )}
      {expanded && headlines && headlines.length > 0 && (
        <div className="mt-2 pt-2 border-t border-white/5 space-y-1.5">
          {headlines.map((h, i) => (
            <div key={i} className="flex items-start gap-2">
              {h.type && (
                <span className="text-[9px] font-medium uppercase tracking-wide text-text-secondary bg-white/5 px-1 py-0.5 rounded shrink-0 mt-0.5">
                  {h.type}
                </span>
              )}
              <a
                href={h.url}
                target="_blank"
                rel="noopener noreferrer"
                onClick={e => e.stopPropagation()}
                className="text-[11px] text-accent hover:underline leading-snug"
              >
                {h.title}
              </a>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ObjectSection({ label, data }: { label: string; data: Record<string, unknown> }) {
  return (
    <div className="border border-white/10 rounded-lg p-3">
      <div className="text-xs font-medium text-accent mb-2">{formatLabel(label)}</div>
      <div className="space-y-1">
        {Object.entries(data).map(([k, v]) => {
          if (v != null && typeof v === 'object' && !Array.isArray(v)) {
            return <ObjectSection key={k} label={k} data={v as Record<string, unknown>} />;
          }
          return (
            <div key={k} className="flex justify-between gap-3 text-xs">
              <span className="text-text-secondary shrink-0">{formatLabel(k)}</span>
              <span className="text-text-primary font-mono text-right">
                {formatValue(v)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function JsonRenderer({ data, onSelect }: { data: unknown; onSelect?: (id: string) => void }) {
  // Array of objects → card list
  if (Array.isArray(data) && data.length > 0 && typeof data[0] === 'object') {
    return (
      <div className="space-y-2">
        {onSelect && (
          <p className="text-[11px] text-text-secondary px-1 mb-1">Click a job to see details</p>
        )}
        {data.map((item, i) => (
          <CardItem key={item?.id ?? i} obj={item as Record<string, unknown>} onSelect={onSelect} />
        ))}
      </div>
    );
  }

  // Object with nested sections (like budget)
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const obj = data as Record<string, unknown>;
    const hasNestedObjects = Object.values(obj).some(v => v && typeof v === 'object' && !Array.isArray(v));

    if (hasNestedObjects) {
      return (
        <div className="space-y-3">
          {Object.entries(obj).map(([k, v]) => {
            if (v && typeof v === 'object' && !Array.isArray(v)) {
              return <ObjectSection key={k} label={k} data={v as Record<string, unknown>} />;
            }
            return (
              <div key={k} className="flex justify-between gap-3 text-sm px-1">
                <span className="text-text-secondary shrink-0">{formatLabel(k)}</span>
                <span className="text-text-primary text-right">{formatValue(v)}</span>
              </div>
            );
          })}
        </div>
      );
    }

    // Flat object → simple key-value list
    return (
      <div className="border border-white/10 rounded-lg p-3 space-y-1.5">
        {Object.entries(obj).map(([k, v]) => (
          <div key={k} className="flex justify-between gap-3 text-xs">
            <span className="text-text-secondary shrink-0">{formatLabel(k)}</span>
            <span className="text-text-primary text-right">{formatValue(v)}</span>
          </div>
        ))}
      </div>
    );
  }

  // Fallback
  return (
    <pre className="text-xs text-text-primary whitespace-pre-wrap">
      {JSON.stringify(data, null, 2)}
    </pre>
  );
}

// ---------------------------------------------------------------------------
// Meeting Action Items renderer
// ---------------------------------------------------------------------------

interface ActionItem {
  id: string;
  text: string;
  assignee: string | null;
  deadline: string | null;
  source: string;
  addedAt: string;
  completed: boolean;
  completedAt: string | null;
}

interface MeetingActionData {
  version?: number;
  lastUpdated?: string;
  items: ActionItem[];
}

function folderColor(source: string): string {
  const s = (source || '').toLowerCase();
  if (s.startsWith('cellebrite/guardian')) return '#3b82f6';
  if (s.startsWith('cellebrite')) return '#60a5fa';
  if (s.startsWith('real estate')) return '#f59e0b';
  if (s.startsWith('my to-dos') || s.startsWith('personal')) return '#4ade80';
  return '#a78bfa';
}

function folderLabel(source: string): string {
  if (!source) return 'Unknown';
  const parts = source.split('/');
  return parts.length >= 2 ? parts.slice(0, 2).join(' / ') : parts[0];
}

function ageLabel(addedAt: string): string {
  if (!addedAt) return '';
  const diffMs = Date.now() - new Date(addedAt).getTime();
  const days = Math.floor(diffMs / 86_400_000);
  if (days === 0) return 'added today';
  if (days === 1) return '1 day old';
  if (days < 7) return `${days} days old`;
  if (days < 14) return '1 week old';
  if (days < 30) return `${Math.floor(days / 7)} weeks old`;
  if (days < 60) return '1 month old';
  return `${Math.floor(days / 30)} months old`;
}

function DeadlineBadge({ deadline }: { deadline: string }) {
  const colors: Record<string, { bg: string; text: string }> = {
    today: { bg: '#ef4444', text: '#fff' },
    tomorrow: { bg: '#f59e0b', text: '#000' },
    sunday: { bg: '#8b5cf6', text: '#fff' },
    q1: { bg: '#0ea5e9', text: '#fff' },
    q2: { bg: '#0ea5e9', text: '#fff' },
    q3: { bg: '#0ea5e9', text: '#fff' },
    q4: { bg: '#0ea5e9', text: '#fff' },
  };
  const c = colors[deadline.toLowerCase()] || { bg: '#475569', text: '#fff' };
  return (
    <span style={{ background: c.bg, color: c.text }} className="text-[10px] font-bold px-1.5 py-0.5 rounded-full uppercase tracking-wide">
      {deadline}
    </span>
  );
}

function AssigneeBadge({ assignee }: { assignee: string }) {
  return (
    <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-blue-900/40 text-blue-300">
      👤 {assignee}
    </span>
  );
}

function MeetingActionItems({ data: initialData, agentKey, tabId }: { data: MeetingActionData; agentKey: string; tabId: string }) {
  const [items, setItems] = useState<ActionItem[]>(initialData?.items ?? []);
  const [showCompleted, setShowCompleted] = useState(false);
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());

  const callApi = async (itemId: string, action: 'complete' | 'uncomplete' | 'delete') => {
    setPendingIds(prev => new Set(prev).add(itemId));
    try {
      await fetch(`/api/agent-data/${agentKey}/${tabId}/${itemId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      setItems(prev => {
        if (action === 'delete') return prev.filter(i => i.id !== itemId);
        return prev.map(i => i.id !== itemId ? i : {
          ...i,
          completed: action === 'complete',
          completedAt: action === 'complete' ? new Date().toISOString() : null,
        });
      });
    } finally {
      setPendingIds(prev => { const s = new Set(prev); s.delete(itemId); return s; });
    }
  };

  const openItems = items.filter(i => !i.completed);
  const completedItems = items.filter(i => i.completed);
  const visibleItems = showCompleted ? items : openItems;

  if (!items.length) {
    return (
      <div className="text-center text-text-secondary py-10">
        <div className="text-3xl mb-2">✅</div>
        <p>All done — no action items.</p>
      </div>
    );
  }

  // Group visible items by folder
  const sorted = [...visibleItems].sort((a, b) => {
    if (a.completed !== b.completed) return a.completed ? 1 : -1;
    return new Date(b.addedAt).getTime() - new Date(a.addedAt).getTime();
  });

  const groups: Record<string, ActionItem[]> = {};
  for (const item of sorted) {
    const label = folderLabel(item.source);
    if (!groups[label]) groups[label] = [];
    groups[label].push(item);
  }

  return (
    <div>
      {/* Header */}
      <div className="flex justify-between items-center mb-3">
        <span className="text-xs text-text-secondary">
          📋 <span className="text-text-primary font-semibold">{openItems.length} open</span>
          {completedItems.length > 0 && (
            <>
              {' · '}
              <button
                onClick={() => setShowCompleted(v => !v)}
                className="text-text-secondary hover:text-accent underline underline-offset-2 transition-colors"
              >
                {showCompleted ? 'hide' : `${completedItems.length} completed`}
              </button>
            </>
          )}
        </span>
        {initialData.lastUpdated && (
          <span className="text-[10px] text-text-secondary/50">
            {new Date(initialData.lastUpdated).toLocaleString()}
          </span>
        )}
      </div>

      {openItems.length === 0 && !showCompleted && (
        <div className="text-center text-text-secondary py-6 text-xs">
          All items complete.{' '}
          <button onClick={() => setShowCompleted(true)} className="text-accent underline">Show {completedItems.length} completed</button>
        </div>
      )}

      {/* Groups */}
      <div className="space-y-3">
        {Object.entries(groups).map(([label, groupItems]) => {
          const color = folderColor(groupItems[0].source);
          return (
            <div
              key={label}
              style={{ borderLeftColor: color }}
              className="border border-white/10 border-l-4 rounded-lg p-3"
            >
              <div style={{ color }} className="text-[10px] font-bold uppercase tracking-wider mb-2">
                {label}
              </div>
              <div className="space-y-2">
                {groupItems.map(item => {
                  const pending = pendingIds.has(item.id);
                  return (
                    <div
                      key={item.id}
                      className={`flex items-start gap-2 ${item.completed ? 'opacity-40' : ''} ${pending ? 'pointer-events-none' : ''}`}
                    >
                      {/* Checkbox */}
                      <button
                        onClick={() => callApi(item.id, item.completed ? 'uncomplete' : 'complete')}
                        style={{ borderColor: item.completed ? '#4ade80' : '#475569', background: item.completed ? '#4ade80' : 'transparent' }}
                        className="w-3.5 h-3.5 min-w-[14px] rounded border-2 mt-0.5 flex items-center justify-center hover:border-green-400 transition-colors shrink-0"
                        title={item.completed ? 'Mark incomplete' : 'Mark complete'}
                      >
                        {item.completed && <span className="text-black text-[8px] font-black leading-none">✓</span>}
                      </button>

                      {/* Content */}
                      <div className="flex-1 min-w-0">
                        <p className={`text-xs leading-snug ${item.completed ? 'line-through text-text-secondary' : 'text-text-primary'}`}>
                          {item.text}
                        </p>
                        <div className="flex gap-1.5 flex-wrap items-center mt-1">
                          {item.deadline && <DeadlineBadge deadline={item.deadline} />}
                          {item.assignee && <AssigneeBadge assignee={item.assignee} />}
                          <span className={`text-[10px] ${item.completed ? 'text-text-secondary/40' : 'text-text-secondary/60'}`}>
                            {ageLabel(item.addedAt)}
                          </span>
                        </div>
                      </div>

                      {/* Delete button — always visible for touch compatibility */}
                      <button
                        onClick={() => callApi(item.id, 'delete')}
                        className="text-text-secondary/30 hover:text-red-400 active:text-red-500 transition-colors text-sm px-1 shrink-0 mt-0.5 touch-manipulation"
                        title="Delete item"
                      >
                        ×
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function AgentInfoTabs({ agentKey }: Props) {
  const agent = useAgentStore((s) => s.agents[agentKey]);
  const [activeTab, setActiveTab] = useState<string | null>(null);
  const [tabData, setTabData] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const [selectedCronId, setSelectedCronId] = useState<string | null>(null);
  // Track which cron-sourced tabs have been pre-fetched and returned empty.
  // null = still checking, Set = resolved
  const [emptyCronTabs, setEmptyCronTabs] = useState<Set<string> | null>(null);

  const allTabs = agent?.tabs || [];
  const cronTabs = allTabs.filter((t) => t.source === 'crons');

  // Pre-fetch all cron tabs on mount/agent change to know upfront which are empty
  useEffect(() => {
    setEmptyCronTabs(null);
    setActiveTab(null);
    setTabData(null);

    if (cronTabs.length === 0) {
      setEmptyCronTabs(new Set());
      return;
    }

    Promise.all(
      cronTabs.map((t) =>
        fetch(`/api/agent-data/${agentKey}/${t.id}`)
          .then((r) => r.json())
          .then((data) => ({ id: t.id, empty: Array.isArray(data) && data.length === 0 }))
          .catch(() => ({ id: t.id, empty: false }))
      )
    ).then((results) => {
      setEmptyCronTabs(new Set(results.filter((r) => r.empty).map((r) => r.id)));
    });
  }, [agentKey]);

  // Filter out cron tabs confirmed empty; show all others (including unresolved)
  const tabs = emptyCronTabs === null
    ? allTabs.filter((t) => t.source !== 'crons')   // still loading: hide cron tabs temporarily
    : allTabs.filter((t) => t.source !== 'crons' || !emptyCronTabs.has(t.id));

  useEffect(() => {
    if (tabs.length > 0 && !activeTab) setActiveTab(tabs[0].id);
  }, [tabs, activeTab]);

  useEffect(() => {
    if (!activeTab) return;
    setLoading(true);
    fetch(`/api/agent-data/${agentKey}/${activeTab}`)
      .then((r) => r.headers.get('content-type')?.includes('json') ? r.json() : r.text())
      .then((data) => { setTabData(data); setLoading(false); })
      .catch(() => setLoading(false));
  }, [agentKey, activeTab]);

  if (tabs.length === 0) return null;

  const currentTab = tabs.find((t) => t.id === activeTab);
  const renderer = currentTab?.renderer || 'default';
  const isCronTab = currentTab?.source === 'crons';

  return (
    <div className="flex flex-col h-full">
      <div className="flex border-b border-white/10 shrink-0 overflow-x-auto">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => { setActiveTab(tab.id); setSelectedCronId(null); }}
            className={`px-3 py-2 text-xs whitespace-nowrap ${
              activeTab === tab.id ? 'border-b-2 border-accent text-accent' : 'text-text-secondary hover:text-text-primary'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Detail panel overlay for cron jobs */}
      {selectedCronId ? (
        <div className="flex-1 overflow-hidden">
          <CronDetailPanel
            jobId={selectedCronId}
            onClose={() => setSelectedCronId(null)}
          />
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto p-3">
          {loading ? (
            <div className="text-text-secondary text-sm">Loading...</div>
          ) : (renderer === 'markdown' || typeof tabData === 'string') && typeof tabData === 'string' ? (
            <div className="prose prose-invert prose-sm max-w-none">
              <ReactMarkdown remarkPlugins={[remarkGfm, remarkFrontmatter]}>{tabData}</ReactMarkdown>
            </div>
          ) : currentTab?.source === 'file:meeting-action-items.json' && tabData && typeof tabData === 'object' && 'items' in (tabData as object) ? (
            <MeetingActionItems data={tabData as MeetingActionData} agentKey={agentKey} tabId={activeTab!} />
          ) : (
            <JsonRenderer data={tabData} onSelect={isCronTab ? setSelectedCronId : undefined} />
          )}
        </div>
      )}
    </div>
  );
}
