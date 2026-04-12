import { useEffect, useState } from 'react';
import { X, Clock, Calendar, Zap, Send, CheckCircle2, AlertCircle, Loader2 } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface CronSchedule {
  kind: string;
  expr?: string;
  tz?: string;
  everyMs?: number;
}

interface CronPayload {
  kind: string;
  message?: string;
  model?: string;
  timeoutSeconds?: number;
}

interface CronDelivery {
  mode?: string;
  channel?: string;
  to?: string;
  bestEffort?: boolean;
}

interface CronState {
  nextRunAtMs?: number;
  lastRunAtMs?: number;
  lastStatus?: string;
  consecutiveErrors?: number;
  lastDurationMs?: number;
  lastDeliveryStatus?: string;
}

interface CronJob {
  id: string;
  agentId: string;
  name: string;
  enabled: boolean;
  createdAtMs?: number;
  updatedAtMs?: number;
  schedule: CronSchedule;
  sessionTarget?: string;
  payload?: CronPayload;
  delivery?: CronDelivery;
  state?: CronState;
}

interface RunEntry {
  ts: number;
  status: string;
  summary?: string;
  durationMs?: number;
  model?: string;
  provider?: string;
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
  delivered?: boolean;
  deliveryStatus?: string;
  runAtMs?: number;
}

interface DetailData {
  job: CronJob;
  runs: RunEntry[];
}

interface Props {
  jobId: string;        // short or full job id
  onClose: () => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatRelative(ms: number): string {
  const diff = Date.now() - ms;
  const abs = Math.abs(diff);
  const future = diff < 0;
  if (abs < 60_000) return future ? 'in < 1m' : '< 1m ago';
  if (abs < 3_600_000) { const m = Math.round(abs / 60_000); return future ? `in ${m}m` : `${m}m ago`; }
  if (abs < 86_400_000) { const h = Math.round(abs / 3_600_000); return future ? `in ${h}h` : `${h}h ago`; }
  const d = Math.round(abs / 86_400_000);
  return future ? `in ${d}d` : `${d}d ago`;
}

function formatDateTime(ms: number): string {
  return new Date(ms).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  });
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

/**
 * Derive a human-readable output description from the delivery object.
 *
 * Gateway semantics:
 *   mode "announce"           → gateway auto-posts the run summary
 *   mode "none" + channel/to  → agent sends output itself via messaging tools
 *   mode "none", no channel   → silent / no output
 *   channel "last"            → replies to whichever channel triggered the job
 *   to "user:..."             → Discord DM
 *   to "#channel-name" or channel id → Discord channel
 */
function describeOutput(delivery?: CronDelivery): string {
  if (!delivery) return 'Silent';

  const { mode, channel, to } = delivery;

  // Resolve destination label
  let dest = '';
  if (to) {
    if (to.startsWith('user:')) dest = 'Discord DM';
    else if (to.startsWith('#') || /^\d{17,19}$/.test(to)) dest = `Discord #${to.replace(/^#/, '')}`;
    else dest = to;
  } else if (channel === 'discord') {
    dest = 'Discord';
  } else if (channel === 'last') {
    dest = 'reply to trigger channel';
  } else if (channel) {
    dest = channel;
  }

  if (mode === 'announce') {
    return dest ? `Auto-delivered → ${dest}` : 'Auto-delivered';
  }

  // mode "none" but has routing → agent sends itself
  if (dest) {
    return `Agent sends → ${dest}`;
  }

  return 'Silent';
}

function formatSchedule(s: CronSchedule): string {
  if (s.kind === 'cron') return s.expr ? `${s.expr}${s.tz ? ` (${s.tz})` : ''}` : 'cron';
  if (s.kind === 'every' && s.everyMs) {
    const ms = s.everyMs;
    if (ms < 60_000) return `Every ${Math.round(ms / 1000)}s`;
    if (ms < 3_600_000) return `Every ${Math.round(ms / 60_000)}m`;
    if (ms < 86_400_000) return `Every ${Math.round(ms / 3_600_000)}h`;
    return `Every ${Math.round(ms / 86_400_000)}d`;
  }
  return s.kind;
}

function StatusIcon({ status }: { status: string }) {
  if (status === 'ok' || status === 'active') return <CheckCircle2 className="w-3.5 h-3.5 text-green-400 shrink-0" />;
  if (status === 'error') return <AlertCircle className="w-3.5 h-3.5 text-red-400 shrink-0" />;
  return <Clock className="w-3.5 h-3.5 text-yellow-400 shrink-0" />;
}

function Pill({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center gap-1.5 px-2.5 py-1.5 bg-surface-overlay rounded-lg border border-white/8">
      <span className="text-[10px] text-text-secondary uppercase tracking-wide shrink-0">{label}</span>
      <span className={`text-xs text-text-primary ${mono ? 'font-mono' : ''} truncate`}>{value}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function CronDetailPanel({ jobId, onClose }: Props) {
  const [data, setData] = useState<DetailData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    fetch(`/api/cron/${jobId}/detail`)
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status}`);
        return r.json();
      })
      .then((d) => { setData(d); setLoading(false); })
      .catch((e) => { setError(e.message); setLoading(false); });
  }, [jobId]);

  return (
    <div className="flex flex-col h-full bg-surface-base border-l border-white/10">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-white/10 shrink-0">
        <Calendar className="w-4 h-4 text-accent shrink-0" />
        <span className="text-sm font-semibold text-text-primary flex-1 truncate">
          {data?.job.name ?? 'Cron Job'}
        </span>
        <button
          onClick={onClose}
          className="p-1 rounded hover:bg-white/10 text-text-secondary hover:text-text-primary transition-colors"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {loading && (
        <div className="flex items-center gap-2 p-4 text-text-secondary text-sm">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading…
        </div>
      )}
      {error && (
        <div className="p-4 text-red-400 text-sm">Failed to load: {error}</div>
      )}

      {data && (
        <div className="flex-1 overflow-y-auto p-4 space-y-5">
          {/* Status row */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`px-2 py-0.5 rounded text-[11px] font-medium ${
              data.job.enabled ? 'bg-green-500/20 text-green-400' : 'bg-gray-500/20 text-gray-400'
            }`}>
              {data.job.enabled ? 'Enabled' : 'Disabled'}
            </span>
            {data.job.state?.consecutiveErrors != null && data.job.state.consecutiveErrors > 0 && (
              <span className="px-2 py-0.5 rounded text-[11px] font-medium bg-red-500/20 text-red-400">
                {data.job.state.consecutiveErrors} consecutive error{data.job.state.consecutiveErrors !== 1 ? 's' : ''}
              </span>
            )}
            {data.job.state?.lastDurationMs != null && (
              <span className="text-[11px] text-text-secondary">
                Last run took {formatDuration(data.job.state.lastDurationMs)}
              </span>
            )}
          </div>

          {/* Schedule + config pills */}
          <div className="grid grid-cols-2 gap-2">
            <Pill label="Schedule" value={formatSchedule(data.job.schedule)} />
            <Pill label="Target" value={data.job.sessionTarget ?? '—'} />
            <Pill label="Type" value={data.job.payload?.kind ?? '—'} />
            <Pill label="Output" value={describeOutput(data.job.delivery)} />
            {data.job.payload?.model && <Pill label="Model" value={data.job.payload.model} mono />}
            {data.job.payload?.timeoutSeconds != null && (
              <Pill label="Timeout" value={data.job.payload.timeoutSeconds === 0 ? 'none' : `${data.job.payload.timeoutSeconds}s`} />
            )}
            {data.job.state?.nextRunAtMs && (
              <Pill label="Next run" value={formatRelative(data.job.state.nextRunAtMs)} />
            )}
          </div>

          {/* Instructions */}
          {data.job.payload?.message && (
            <div>
              <div className="flex items-center gap-1.5 mb-2">
                <Zap className="w-3.5 h-3.5 text-accent" />
                <span className="text-xs font-semibold text-text-primary uppercase tracking-wide">Instructions</span>
              </div>
              <div className="bg-surface-overlay rounded-lg p-3 border border-white/8">
                <div className="prose prose-invert prose-xs max-w-none text-xs [&_p]:mb-2 [&_p:last-child]:mb-0">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{data.job.payload.message}</ReactMarkdown>
                </div>
              </div>
            </div>
          )}

          {/* Recent runs */}
          {data.runs.length > 0 && (
            <div>
              <div className="flex items-center gap-1.5 mb-2">
                <Clock className="w-3.5 h-3.5 text-accent" />
                <span className="text-xs font-semibold text-text-primary uppercase tracking-wide">Recent Runs</span>
              </div>
              <div className="space-y-2">
                {data.runs.map((run, i) => (
                  <RunCard key={i} run={run} />
                ))}
              </div>
            </div>
          )}

          {/* Metadata footer */}
          <div className="pt-2 border-t border-white/8 space-y-1">
            {data.job.createdAtMs && (
              <div className="flex justify-between text-[11px]">
                <span className="text-text-secondary">Created</span>
                <span className="text-text-primary">{formatDateTime(data.job.createdAtMs)}</span>
              </div>
            )}
            {data.job.updatedAtMs && data.job.updatedAtMs !== data.job.createdAtMs && (
              <div className="flex justify-between text-[11px]">
                <span className="text-text-secondary">Updated</span>
                <span className="text-text-primary">{formatDateTime(data.job.updatedAtMs)}</span>
              </div>
            )}
            <div className="flex justify-between text-[11px]">
              <span className="text-text-secondary">Job ID</span>
              <span className="text-text-primary font-mono">{data.job.id.slice(0, 8)}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Run card
// ---------------------------------------------------------------------------

function RunCard({ run }: { run: RunEntry }) {
  const [expanded, setExpanded] = useState(false);
  const hasSummary = run.summary && run.summary.trim().length > 0 &&
    !/^(NO_REPLY|ANNOUNCE_SKIP|HEARTBEAT_OK)$/i.test(run.summary.trim());

  return (
    <div
      className={`border rounded-lg border-white/10 overflow-hidden ${hasSummary ? 'cursor-pointer hover:border-white/20' : ''} transition-colors`}
      onClick={() => hasSummary && setExpanded((e) => !e)}
    >
      <div className="flex items-start gap-2 px-3 py-2">
        <StatusIcon status={run.status} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-text-primary">
              {run.runAtMs ? formatRelative(run.runAtMs) : formatRelative(run.ts)}
            </span>
            {run.durationMs != null && (
              <span className="text-[11px] text-text-secondary">{formatDuration(run.durationMs)}</span>
            )}
            {run.model && (
              <span className="text-[10px] text-text-secondary font-mono truncate">{run.model}</span>
            )}
            {run.usage?.total_tokens != null && (
              <span className="text-[10px] text-text-secondary">
                {run.usage.total_tokens.toLocaleString()} tok
              </span>
            )}
            {run.delivered === true && (
              <span className="flex items-center gap-0.5 text-[10px] text-green-400">
                <Send className="w-2.5 h-2.5" /> delivered
              </span>
            )}
          </div>
        </div>
        {hasSummary && (
          <span className="text-[10px] text-text-secondary shrink-0">{expanded ? '▲' : '▼'}</span>
        )}
      </div>
      {expanded && hasSummary && run.summary && (
        <div className="px-3 pb-3 pt-1 border-t border-white/8">
          <div className="prose prose-invert prose-xs max-w-none text-xs [&_p]:mb-1.5 [&_p:last-child]:mb-0">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{run.summary}</ReactMarkdown>
          </div>
        </div>
      )}
    </div>
  );
}
