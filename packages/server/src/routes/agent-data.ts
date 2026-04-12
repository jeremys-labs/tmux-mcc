import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import type { AppConfig } from '../types/config.js';
import type { GatewayClient } from '../gateway/client.js';


// ---------------------------------------------------------------------------
// Cron data types (subset of what gateway returns)
// ---------------------------------------------------------------------------

interface CronSchedule {
  kind: string;
  expr?: string;
  tz?: string;
  everyMs?: number;
  anchorMs?: number;
}

interface CronState {
  nextRunAtMs?: number;
  lastRunAtMs?: number;
  lastStatus?: string;
  consecutiveErrors?: number;
  lastDurationMs?: number;
  lastRunStatus?: string;
  lastDeliveryStatus?: string;
  lastDelivered?: boolean;
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

interface CronRunEntry {
  ts: number;
  jobId: string;
  action: string;
  status: string;
  summary?: string;
  runAtMs?: number;
  durationMs?: number;
  model?: string;
  provider?: string;
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
  delivered?: boolean;
  deliveryStatus?: string;
}

interface CronListResponse {
  jobs: CronJob[];
}

// ---------------------------------------------------------------------------
// Schedule formatting helpers
// ---------------------------------------------------------------------------

function formatSchedule(schedule: CronSchedule): string {
  if (schedule.kind === 'cron') {
    return formatCronExpression(schedule.expr || '', schedule.tz);
  }
  if (schedule.kind === 'every' && schedule.everyMs) {
    return formatEvery(schedule.everyMs);
  }
  return schedule.kind;
}

function formatEvery(ms: number): string {
  if (ms < 60_000) return `Every ${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `Every ${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `Every ${Math.round(ms / 3_600_000)}h`;
  return `Every ${Math.round(ms / 86_400_000)}d`;
}

// Very lightweight cron expression → human-readable description
function formatCronExpression(expr: string, tz?: string): string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length < 5) return expr;

  const [min, hour, dom, , dow] = parts;
  const tzLabel = tz ? ` (${tz.replace('America/', '')})` : '';

  // Every day at HH:MM
  if (dom === '*' && dow === '*' && /^\d+$/.test(hour) && /^\d+$/.test(min)) {
    const h = parseInt(hour, 10);
    const m = parseInt(min, 10);
    const ampm = h >= 12 ? 'pm' : 'am';
    const h12 = h % 12 || 12;
    const mStr = m === 0 ? '' : `:${String(m).padStart(2, '0')}`;
    return `Daily at ${h12}${mStr}${ampm}${tzLabel}`;
  }

  // Weekdays at HH:MM (1-5)
  if (dow === '1-5' && /^\d+$/.test(hour) && /^\d+$/.test(min)) {
    const h = parseInt(hour, 10);
    const m = parseInt(min, 10);
    const ampm = h >= 12 ? 'pm' : 'am';
    const h12 = h % 12 || 12;
    const mStr = m === 0 ? '' : `:${String(m).padStart(2, '0')}`;
    return `Weekdays at ${h12}${mStr}${ampm}${tzLabel}`;
  }

  // Specific weekday at HH:MM
  const DOW_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  if (/^\d$/.test(dow) && /^\d+$/.test(hour) && /^\d+$/.test(min)) {
    const h = parseInt(hour, 10);
    const m = parseInt(min, 10);
    const ampm = h >= 12 ? 'pm' : 'am';
    const h12 = h % 12 || 12;
    const mStr = m === 0 ? '' : `:${String(m).padStart(2, '0')}`;
    const dayName = DOW_NAMES[parseInt(dow, 10)] || `day ${dow}`;
    return `${dayName}s at ${h12}${mStr}${ampm}${tzLabel}`;
  }

  return `${expr}${tzLabel}`;
}

function formatRelativeTime(ms: number): string {
  const diffMs = Date.now() - ms;
  const abs = Math.abs(diffMs);
  const future = diffMs < 0;

  if (abs < 60_000) return future ? 'in < 1m' : '< 1m ago';
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

// Map gateway status to a card-compatible status string
function mapStatus(job: CronJob): string {
  if (!job.enabled) return 'disabled';
  const s = job.state?.lastStatus;
  if (!s || s === 'ok') return 'active';
  if (s === 'error') return 'error';
  return s;
}

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Helper: resolve the backing file path for a file: source tab
// ---------------------------------------------------------------------------
function resolveFileSourcePath(contentRoot: string, agentKey: string, source: string): string | null {
  if (!source.startsWith('file:')) return null;
  const fileName = source.slice(5);
  const baseName = fileName.replace(/\.[^.]+$/, '');
  const searchDirs = [
    path.join(contentRoot, 'workspace', 'agents', agentKey),
    path.join(contentRoot, 'data'),
  ];
  const candidates = [
    fileName,
    ...(fileName.endsWith('.json') ? [`${baseName}.md`] : [`${baseName}.json`]),
  ];
  for (const dir of searchDirs) {
    for (const candidate of candidates) {
      const p = path.join(dir, candidate);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

export function createAgentDataRoutes(config: AppConfig, contentRoot: string, gateway?: GatewayClient): Router {
  const router = Router();

  router.get('/agent-data/:agentKey/:tabId', async (req, res) => {
    const { agentKey, tabId } = req.params;
    const agent = config.agents[agentKey as string];
    if (!agent) { res.status(404).json({ error: 'Agent not found' }); return; }

    const tab = agent.tabs.find((t) => t.id === tabId);
    if (!tab) { res.status(404).json({ error: 'Tab not found' }); return; }

    const source = tab.source;

    // ------------------------------------------------------------------
    // source: file:<name>
    // ------------------------------------------------------------------
    if (source.startsWith('file:')) {
      const fileName = source.slice(5);
      const baseName = fileName.replace(/\.[^.]+$/, '');

      // Search order: agent-specific workspace dir, then global data dir
      const searchDirs = [
        path.join(contentRoot, 'workspace', 'agents', agentKey as string),
        path.join(contentRoot, 'data'),
      ];

      // Try exact filename, then alternate extension (.md↔.json)
      const candidates = [
        fileName,
        ...(fileName.endsWith('.json') ? [`${baseName}.md`] : [`${baseName}.json`]),
      ];

      let resolved: string | null = null;
      for (const dir of searchDirs) {
        for (const candidate of candidates) {
          const p = path.join(dir, candidate);
          if (fs.existsSync(p)) { resolved = p; break; }
        }
        if (resolved) break;
      }

      if (!resolved) { res.json(null); return; }

      const ext = path.extname(resolved);
      if (ext === '.json') {
        res.json(JSON.parse(fs.readFileSync(resolved, 'utf-8')));
      } else {
        res.type('text/plain').send(fs.readFileSync(resolved, 'utf-8'));
      }
      return;
    }

    // ------------------------------------------------------------------
    // source: about
    // ------------------------------------------------------------------
    if (source === 'about') {
      const aboutPath = path.join(contentRoot, 'workspace', 'agents', agentKey as string, 'about.md');
      if (fs.existsSync(aboutPath)) {
        res.type('text/plain').send(fs.readFileSync(aboutPath, 'utf-8'));
      } else {
        // Fallback until the agent creates their about.md
        const lines = [
          `# ${agent.name}`,
          '',
          `**Role:** ${agent.role}`,
          '',
        ];
        if (agent.quote) lines.push(`> ${agent.quote}`, '');
        lines.push(`**Channel:** ${agent.channel}`);
        res.type('text/plain').send(lines.join('\n'));
      }
      return;
    }

    // ------------------------------------------------------------------
    // source: memory
    // ------------------------------------------------------------------
    if (source === 'memory') {
      const memPath = path.join(contentRoot, 'memory', 'agents', `${agentKey}.md`);
      if (fs.existsSync(memPath)) {
        res.type('text/plain').send(fs.readFileSync(memPath, 'utf-8'));
      } else {
        res.type('text/plain').send('');
      }
      return;
    }

    // ------------------------------------------------------------------
    // source: crons
    // Fetches scheduled jobs for this agent from the gateway.
    // ------------------------------------------------------------------
    if (source === 'crons') {
      if (!gateway || !gateway.isConnected) {
        res.json([]);
        return;
      }

      try {
        const result = await gateway.request('cron.list', {
          query: agentKey as string,
          limit: 50,
        }) as CronListResponse | null;

        const jobs: CronJob[] = result?.jobs ?? [];

        // Filter to this agent only (query is a text search, not a strict filter)
        const agentJobs = jobs.filter((j) => j.agentId === agentKey);

        // Shape each job into a card-friendly object
        const cards = agentJobs.map((job) => ({
          id: job.id.slice(0, 8),        // Short ID for display
          name: job.name,
          status: mapStatus(job),
          schedule: formatSchedule(job.schedule),
          ...(job.state?.nextRunAtMs ? { next: formatRelativeTime(job.state.nextRunAtMs) } : {}),
          ...(job.state?.lastRunAtMs ? { last: formatRelativeTime(job.state.lastRunAtMs) } : {}),
          ...(job.state?.consecutiveErrors && job.state.consecutiveErrors > 0
            ? { errors: job.state.consecutiveErrors }
            : {}),
        }));

        res.json(cards);
      } catch (err) {
        console.error('[agent-data] cron.list error:', err);
        res.json([]);
      }
      return;
    }

    res.status(400).json({ error: `Unsupported source type: ${source}` });
  });

  // ------------------------------------------------------------------
  // GET /api/cron/:jobId/detail
  // Returns the full job definition + recent run history
  // ------------------------------------------------------------------
  router.get('/cron/:jobId/detail', async (req, res) => {
    if (!gateway || !gateway.isConnected) {
      res.status(503).json({ error: 'Gateway not connected' });
      return;
    }

    const { jobId } = req.params;

    try {
      // Fetch full job list and find the matching job by id prefix or full id
      const listResult = await gateway.request('cron.list', { limit: 200 }) as { jobs: CronJob[] } | null;
      const jobs = listResult?.jobs ?? [];
      const job = jobs.find((j) => j.id === jobId || j.id.startsWith(jobId));

      if (!job) {
        res.status(404).json({ error: 'Job not found' });
        return;
      }

      // Fetch recent runs
      let runs: CronRunEntry[] = [];
      try {
        const runsResult = await gateway.request('cron.runs', { jobId: job.id, limit: 5 }) as { entries: CronRunEntry[] } | null;
        runs = runsResult?.entries ?? [];
      } catch {
        // runs are optional — don't fail the whole request
      }

      res.json({ job, runs });
    } catch (err) {
      console.error('[agent-data] cron detail error:', err);
      res.status(500).json({ error: 'Failed to fetch cron detail' });
    }
  });

  // ------------------------------------------------------------------
  // PATCH /api/agent-data/:agentKey/:tabId/:itemId
  // Body: { action: "complete" | "uncomplete" | "delete" }
  // Mutates the backing JSON file in-place.
  // ------------------------------------------------------------------
  router.patch('/agent-data/:agentKey/:tabId/:itemId', (req, res) => {
    const { agentKey, tabId, itemId } = req.params;
    const { action } = req.body as { action: string };

    if (!['complete', 'uncomplete', 'delete'].includes(action)) {
      res.status(400).json({ error: 'action must be complete | uncomplete | delete' });
      return;
    }

    const agent = config.agents[agentKey as string];
    if (!agent) { res.status(404).json({ error: 'Agent not found' }); return; }

    const tab = agent.tabs.find((t) => t.id === tabId);
    if (!tab) { res.status(404).json({ error: 'Tab not found' }); return; }

    const filePath = resolveFileSourcePath(contentRoot, agentKey as string, tab.source);
    if (!filePath || !filePath.endsWith('.json')) {
      res.status(400).json({ error: 'Tab source is not a writable JSON file' });
      return;
    }

    let data: { items: Array<{ id: string; completed: boolean; completedAt: string | null; [k: string]: unknown }>; deleted?: string[] };
    try {
      data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch {
      res.status(500).json({ error: 'Failed to read file' });
      return;
    }

    if (!Array.isArray(data.items)) {
      res.status(400).json({ error: 'File does not have an items array' });
      return;
    }

    const idx = data.items.findIndex((item) => item.id === itemId);
    if (idx === -1) {
      res.status(404).json({ error: 'Item not found' });
      return;
    }

    if (action === 'delete') {
      const [removed] = data.items.splice(idx, 1);
      // Tombstone the text so the import script never re-adds this item
      if (!Array.isArray(data.deleted)) data.deleted = [];
      const normalizedText = (String(removed.text || '')).toLowerCase().trim();
      if (normalizedText && !data.deleted.includes(normalizedText)) {
        data.deleted.push(normalizedText);
      }
    } else if (action === 'complete') {
      data.items[idx].completed = true;
      data.items[idx].completedAt = new Date().toISOString();
    } else {
      data.items[idx].completed = false;
      data.items[idx].completedAt = null;
    }

    (data as Record<string, unknown>).lastUpdated = new Date().toISOString();

    try {
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
    } catch {
      res.status(500).json({ error: 'Failed to write file' });
      return;
    }

    res.json({ ok: true, action, itemId });
  });

  return router;
}
