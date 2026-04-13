import { Router } from 'express';
import type { Request, Response } from 'express';
import fs from 'fs';
import path from 'path';

const SCHEDULER_DIR = process.env.SCHEDULER_DIR ?? path.join(process.env.HOME || '', '.claude', 'scheduler');
const JOBS_PATH = path.join(SCHEDULER_DIR, 'jobs.json');
const LOGS_DIR = path.join(SCHEDULER_DIR, 'logs');

interface DaemonJob {
  id: string;
  label: string;
  agent: string;
  agentDir?: string;
  type?: string;
  cron?: string;
  fireAt?: string;
  model?: string;
  prompt?: string;
  timeoutSeconds?: number;
  enabled?: boolean;
  created?: string;
  notify?: string;
  maxRetries?: number;
  pauseAfterErrors?: number;
}

function readJobs(): DaemonJob[] {
  try {
    const raw = fs.readFileSync(JOBS_PATH, 'utf-8');
    const data = JSON.parse(raw);
    return Array.isArray(data.jobs) ? data.jobs : [];
  } catch {
    return [];
  }
}

/** Map daemon job format → client CronJob shape */
function mapJob(job: DaemonJob) {
  return {
    id: job.id,
    agentId: job.agent,
    name: job.label,
    enabled: job.enabled !== false,
    createdAtMs: job.created ? new Date(job.created).getTime() : undefined,
    schedule: {
      kind: job.type === 'once' ? 'once' : 'cron',
      expr: job.cron,
    },
    payload: {
      kind: 'prompt',
      message: job.prompt,
      model: job.model,
      timeoutSeconds: job.timeoutSeconds,
    },
  };
}

/** Scan log files for a job and extract run history */
function getRunHistory(jobId: string, limit = 20) {
  if (!fs.existsSync(LOGS_DIR)) return [];
  const prefix = `${jobId}-`;
  const logFiles = fs.readdirSync(LOGS_DIR)
    .filter((f) => f.startsWith(prefix) && f.endsWith('.log'))
    .sort()
    .reverse()
    .slice(0, limit);

  return logFiles.map((f) => {
    // Filename: {jobId}-{YYYY-MM-DDTHH-MM-SS}.log
    const tsStr = f.slice(prefix.length, -4).replace(/-/g, (m, offset: number) => {
      // Replace hyphens back to colons for time portion (after the date part)
      // Format: 2026-04-12T13-00-01 → 2026-04-12T13:00:01
      if (offset > 10) return ':';
      return m;
    });
    const ts = new Date(tsStr).getTime() || 0;

    let summary = '';
    try {
      const content = fs.readFileSync(path.join(LOGS_DIR, f), 'utf-8');
      // Skip the header line (=== ... ===), take the first meaningful line
      const lines = content.split('\n').filter((l) => !l.startsWith('===') && l.trim());
      summary = lines[0]?.slice(0, 200) ?? '';
    } catch { /* ignore */ }

    return {
      ts,
      status: 'complete',
      summary,
      runAtMs: ts,
    };
  });
}

export function createCronRouter(): Router {
  const router = Router();

  /** List jobs for an agent — used by agent-data source: "crons" */
  router.get('/cron/agent/:agentKey', (req: Request, res: Response) => {
    const agentKey = req.params['agentKey'] as string;
    const jobs = readJobs().filter((j) => j.agent === agentKey);
    res.json(jobs.map(mapJob));
  });

  /** Job detail + run history — used by CronDetailPanel */
  router.get('/cron/:jobId/detail', (req: Request, res: Response) => {
    const jobId = req.params['jobId'] as string;
    const job = readJobs().find((j) => j.id === jobId);
    if (!job) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }
    res.json({
      job: mapJob(job),
      runs: getRunHistory(jobId),
    });
  });

  return router;
}
