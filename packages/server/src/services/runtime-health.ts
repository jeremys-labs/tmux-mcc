import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import Database from 'better-sqlite3';
import { resolveOpenBrainRuntimeConfig } from './open-brain-runtime.js';
import { buildSkillSnapshot } from './skill-snapshot.js';
import { readPendingInboxEntries } from './codex-inbox.js';
import { readPreSessionContextRecord } from './runtime-pre-session.js';

const DEFAULT_AGENTS_ROOT = '/Volumes/Repo-Drive/agents';
const DEFAULT_SCHEDULER_ROOT = '/Users/jeremylahners/.claude/scheduler';
const DEFAULT_AGENT_MAIL_DB = '/Volumes/Repo-Drive/agents/SHARED/agent-mail/agent_mail.db';
const DEFAULT_SCHEDULED_OUTBOX = '/Volumes/Repo-Drive/agents/SHARED/scheduled-discord-outbox.jsonl';
const DEFAULT_OPEN_BRAIN_ENV_PATH = '/Volumes/Repo-Drive/src/open-brain/credentials/ob1.env';
const DEFAULT_CODEX_CONFIG_PATH = '/Users/jeremylahners/.codex/config.toml';
const DEFAULT_CONTENT_ROOT = '/Users/jeremylahners/.tmux-mcc';
const DEFAULT_OPEN_PR_DIGEST_STATUS_PATH = '/Users/jeremylahners/.tmux-mcc/bridge/pr-digest/open-pr-digest-status.json';

export type HealthStatus = 'ok' | 'warn' | 'error' | 'unknown';

export interface HealthCheck {
  status: HealthStatus;
  detail: string;
}

export interface AgentRuntimeHealth {
  agent: string;
  runtimeLaunchConfig: HealthCheck;
  runtimeType: HealthCheck;
  discordBridgeConfig: HealthCheck;
  codexInboundBridge: HealthCheck;
  discordInboxDelivery: HealthCheck;
  codexOutboundDiscordMcp: HealthCheck;
  discordOutboundMcp: HealthCheck;
  openBrainMemoryKey: HealthCheck;
  lastOpenBrainCapture: HealthCheck;
  lastOpenBrainSearch: HealthCheck;
  groomingQueueDepth: HealthCheck;
  agentMail: HealthCheck;
  skillSnapshot: HealthCheck;
  preSessionContext: HealthCheck;
  migrationReadiness: HealthCheck;
}

export interface SchedulerHealth {
  jobsFile: string;
  validJobTypes: string[];
  jobCount: number;
  invalidTypeJobs: Array<{ id: string; label: string; type: string }>;
  staleOneShotJobs: Array<{ id: string; label: string; fireAt: string; staleMinutes: number }>;
  staleRecurringJobs: Array<{ id: string; label: string; cron: string; lastLogAt?: string; staleHours?: number; reason: string }>;
  checks: {
    jobTypes: HealthCheck;
    staleOneShots: HealthCheck;
    staleRecurring: HealthCheck;
    schedulerHeartbeat: HealthCheck;
    openPrDigest: HealthCheck;
  };
}

export interface AgentMailHealth {
  dbPath: string;
  agents: Record<string, {
    inboxDepth: number;
    oldestUnackedAt?: string;
    oldestUnackedAgeMinutes?: number;
  }>;
  outbox: HealthCheck;
}

export interface RuntimeHealthReport {
  generatedAtIso: string;
  durationMs: number;
  agents: AgentRuntimeHealth[];
  scheduler: SchedulerHealth;
  agentMail: AgentMailHealth;
  summary: HealthCheck;
}

export interface RuntimeHealthOptions {
  agents?: string[];
  agentsRoot?: string;
  schedulerRoot?: string;
  agentMailDbPath?: string;
  scheduledOutboxPath?: string;
  now?: Date;
  openBrainSearchTimeoutMs?: number;
  includeOpenBrainSearch?: boolean;
  includeOpenBrainMetadata?: boolean;
  codexConfigPath?: string;
  contentRoot?: string;
  openPrDigestStatusPath?: string;
}

interface SchedulerJob {
  id?: string;
  label?: string;
  agent?: string;
  type?: string;
  cron?: string;
  fireAt?: string;
  enabled?: boolean;
  command?: string;
  prompt?: string;
}

interface OpenPrDigestRunStatus {
  runAtIso?: string;
  status?: string;
  reason?: string;
  sweepExitCode?: number;
  deliveryOk?: boolean;
  digestChars?: number;
  deliveryMessageId?: string;
}

interface ThoughtMetadata {
  owner_agent?: string;
  agent_id?: string;
  scope?: string;
  grooming_status?: string;
}

interface ThoughtRow {
  created_at: string;
  metadata?: ThoughtMetadata;
}

function readJsonFile<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch {
    return null;
  }
}

function readTrimmed(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8').trim();
  } catch {
    return null;
  }
}

function fileExists(filePath: string): boolean {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function readOptional(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function fileMtimeIso(filePath: string): string | undefined {
  try {
    return fs.statSync(filePath).mtime.toISOString();
  } catch {
    return undefined;
  }
}

function minutesBetween(now: Date, iso: string): number {
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return Number.POSITIVE_INFINITY;
  return Math.max(0, Math.round((now.getTime() - ts) / 60_000));
}

function check(status: HealthStatus, detail: string): HealthCheck {
  return { status, detail };
}

function hasDiscordChannels(accessPath: string): boolean {
  const access = readJsonFile<{ groups?: Record<string, unknown> }>(accessPath);
  return Object.keys(access?.groups ?? {}).length > 0;
}

function runtimeLaunchConfigCheck(agent: string, agentsRoot: string): HealthCheck {
  const launchPath = path.join(agentsRoot, agent, 'launch.sh');
  const launch = readOptional(launchPath);
  if (!launch) return check('error', `missing launcher at ${launchPath}`);
  const required = [
    'npm run runtime-launch',
    `--agent ${agent}`,
    '--runtime "$LAUNCH_RUNTIME"',
  ];
  const missing = required.filter((needle) => !launch.includes(needle));
  return missing.length === 0
    ? check('ok', 'launcher delegates to runtime-launch')
    : check('error', `launcher is not Pi/runtime-launch ready; missing ${missing.join(', ')}`);
}

function codexDiscordMcpCheck(agent: string, agentsRoot: string, codexConfigPath: string): HealthCheck {
  const config = readOptional(codexConfigPath);
  if (!config) return check('warn', `Codex config missing at ${codexConfigPath}`);

  const serverHeader = `[mcp_servers.discord-${agent}]`;
  if (!config.includes(serverHeader)) {
    return check('warn', `missing ${serverHeader} in Codex config`);
  }

  const wrapperPath = path.join(agentsRoot, agent, 'bin', 'discord-mcp-wrapper');
  if (!fileExists(wrapperPath)) {
    return check('warn', `missing outbound Discord MCP wrapper at ${wrapperPath}`);
  }

  return check('ok', `discord-${agent} MCP configured`);
}

function sharedDiscordBridgeOutboundCheck(agent: string, contentRoot: string): HealthCheck {
  const socketPath = process.env.DISCORD_BRIDGE_SOCKET_PATH ?? '/tmp/agent-discord-bridge.sock';
  if (fileExists(socketPath)) return check('ok', `shared Discord bridge socket exists at ${socketPath}`);

  const defaultConfigPath = path.join(contentRoot, 'bridge', 'discord.json');
  if (bridgeConfigContainsAgent(defaultConfigPath, agent)) {
    return check('warn', `shared bridge config includes ${agent}, but socket missing at ${socketPath}`);
  }

  return check('warn', `shared Discord bridge socket missing at ${socketPath}`);
}

function discordOutboundMcpCheck(agent: string, runtime: string | null, agentsRoot: string, codexConfigPath: string, contentRoot: string, hasDiscordConfig: boolean): HealthCheck {
  if (!hasDiscordConfig) return check('ok', 'no Discord channels configured');
  if (runtime === 'codex') return codexDiscordMcpCheck(agent, agentsRoot, codexConfigPath);
  if (runtime === 'claude') return sharedDiscordBridgeOutboundCheck(agent, contentRoot);
  return check('error', `unsupported runtime for outbound Discord MCP: ${runtime ?? 'unknown'}`);
}

function skillSnapshotCheck(agent: string, agentsRoot: string): HealthCheck {
  const snapshot = buildSkillSnapshot({ agentKey: agent, agentsRoot });
  const names = snapshot.skills.map((skill) => skill.name);
  if (snapshot.skills.length === 0) return check('error', 'no central or agent skills projected');
  if (!names.includes('runtime-canary')) return check('error', `runtime-canary skill missing from snapshot ${snapshot.version}`);
  return check('ok', `${snapshot.skills.length} skill(s), version=${snapshot.version}`);
}

function preSessionContextCheck(agent: string, contentRoot: string): HealthCheck {
  const ctx = readPreSessionContextRecord(contentRoot, agent);
  if (!ctx) return check('warn', 'no startup context record — agent may have started cold (no SOUL.md and no OB1 memory at last launch)');
  const { hasSoul, hasMemory, runtime, generatedAt } = ctx;
  if (hasSoul && hasMemory) return check('ok', `soul=true memory=true runtime=${runtime} at ${generatedAt}`);
  if (!hasSoul && !hasMemory) return check('warn', `cold start: soul=false memory=false runtime=${runtime} at ${generatedAt}`);
  if (!hasSoul) return check('warn', `no SOUL.md at last start: soul=false memory=true runtime=${runtime} at ${generatedAt}`);
  return check('warn', `no OB1 memory at last start: soul=true memory=false runtime=${runtime} at ${generatedAt}`);
}

function tmuxSessionExists(session: string): boolean {
  try {
    execFileSync('tmux', ['has-session', '-t', session], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function bridgeConfigContainsAgent(configPath: string, agent: string): boolean {
  const config = readJsonFile<{ bindings?: Array<{ name?: string; subscriptions?: Array<{ agentKey?: string }> }>; subscriptions?: Array<{ agentKey?: string }> }>(configPath);
  if (!config) return false;
  if (config.bindings?.some((binding) => binding.name === agent || binding.subscriptions?.some((sub) => sub.agentKey === agent))) {
    return true;
  }
  return config.subscriptions?.some((sub) => sub.agentKey === agent) ?? false;
}

function codexInboundBridgeCheck(agent: string, contentRoot: string): HealthCheck {
  const defaultConfigPath = path.join(contentRoot, 'bridge', 'discord.json');
  if (bridgeConfigContainsAgent(defaultConfigPath, agent)) {
    return check('ok', `shared bridge config includes ${agent}`);
  }
  const inboxPath = path.join(contentRoot, 'bridge', 'inbox', `${agent}.jsonl`);
  if (fileExists(inboxPath)) {
    return check('ok', `runtime inbox exists at ${inboxPath}`);
  }
  if (tmuxSessionExists(`${agent}-discord-bridge`)) {
    return check('ok', `tmux bridge session ${agent}-discord-bridge is running`);
  }
  return check('warn', `no shared bridge binding, runtime inbox, or ${agent}-discord-bridge tmux session found`);
}

function discordInboxDeliveryCheck(agent: string, contentRoot: string, now: Date, hasDiscordConfig: boolean): HealthCheck {
  if (!hasDiscordConfig) return check('ok', 'no Discord channels configured');
  const pending = readPendingInboxEntries(contentRoot, agent);
  if (pending.length === 0) return check('ok', '0 pending Discord inbox entries');

  const oldest = pending
    .map((entry) => entry.timestamp)
    .filter((timestamp): timestamp is string => typeof timestamp === 'string' && timestamp.length > 0)
    .sort()[0];
  const age = oldest ? minutesBetween(now, oldest) : undefined;
  const ageDetail = oldest && age !== undefined ? `; oldest ${oldest} (${age}m)` : '';
  const status = age !== undefined && age >= 5 ? 'error' : 'warn';
  return check(status, `${pending.length} pending Discord inbox entries after cursor${ageDetail}`);
}

function worstStatus(checks: HealthCheck[]): HealthStatus {
  if (checks.some((item) => item.status === 'error')) return 'error';
  if (checks.some((item) => item.status === 'warn')) return 'warn';
  if (checks.some((item) => item.status === 'unknown')) return 'unknown';
  return 'ok';
}

function evaluateMigrationReadiness(agent: AgentRuntimeHealth): HealthCheck {
  const blockers: string[] = [];
  const requiredChecks: Array<[string, HealthCheck]> = [
    ['launcher', agent.runtimeLaunchConfig],
    ['runtime', agent.runtimeType],
    ['discord', agent.discordBridgeConfig],
    ['codex-in', agent.codexInboundBridge],
    ['delivery', agent.discordInboxDelivery],
    ['discord-out', agent.discordOutboundMcp],
    ['ob1-key', agent.openBrainMemoryKey],
    ['capture', agent.lastOpenBrainCapture],
    ['search', agent.lastOpenBrainSearch],
    ['mail', agent.agentMail],
    ['skills', agent.skillSnapshot],
  ];

  for (const [name, health] of requiredChecks) {
    if (health.status !== 'ok') {
      blockers.push(`${name}=${health.status}`);
    }
  }

  return blockers.length === 0
    ? check('ok', 'all migration gates green')
    : check('error', `migration blockers: ${blockers.join(', ')}`);
}

function resolveAgents(options: RuntimeHealthOptions): string[] {
  if (options.agents?.length) return options.agents;
  const agentsRoot = options.agentsRoot ?? DEFAULT_AGENTS_ROOT;
  try {
    return fs.readdirSync(agentsRoot)
      .filter((name) => fileExists(path.join(agentsRoot, name, 'launch.sh')))
      .sort();
  } catch {
    return [];
  }
}

export function loadSchedulerValidJobTypes(schedulerRoot = DEFAULT_SCHEDULER_ROOT): string[] {
  const parsed = readJsonFile<{ validTypes?: unknown[] }>(path.join(schedulerRoot, 'job-types.json'));
  return parsed?.validTypes?.filter((item): item is string => typeof item === 'string') ?? [];
}

function loadSchedulerJobs(schedulerRoot: string): SchedulerJob[] {
  const parsed = readJsonFile<{ jobs?: SchedulerJob[] }>(path.join(schedulerRoot, 'jobs.json'));
  return parsed?.jobs ?? [];
}

function latestLogMtimeForJob(logsDir: string, jobId: string): string | undefined {
  try {
    const prefix = `${jobId}-`;
    const files = fs.readdirSync(logsDir).filter((name) => name.startsWith(prefix) && name.endsWith('.log'));
    let latest: string | undefined;
    for (const file of files) {
      const mtime = fileMtimeIso(path.join(logsDir, file));
      if (mtime && (!latest || mtime > latest)) latest = mtime;
    }
    return latest;
  } catch {
    return undefined;
  }
}

function cronPeriodMs(expr: string): number | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
  if (minute.startsWith('*/') && hour === '*' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    const minutes = Number(minute.slice(2));
    return Number.isFinite(minutes) && minutes > 0 ? minutes * 60_000 : null;
  }
  if (hour === '*' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') return 60 * 60_000;
  if (dayOfMonth === '*' && month === '*' && dayOfWeek === '*') return 24 * 60 * 60_000;
  if (dayOfMonth === '*' && month === '*' && dayOfWeek !== '*') return 7 * 24 * 60 * 60_000;
  if (dayOfMonth !== '*' && month === '*' && dayOfWeek === '*') return 31 * 24 * 60 * 60_000;
  return null;
}

function isOpenPrDigestJob(job: SchedulerJob): boolean {
  const haystack = `${job.id ?? ''} ${job.label ?? ''} ${job.command ?? ''} ${job.prompt ?? ''}`.toLowerCase();
  return haystack.includes('open-pr-digest');
}

function openPrDigestStatusCheck(jobs: SchedulerJob[], statusPath: string, now: Date): HealthCheck {
  if (!jobs.some(isOpenPrDigestJob)) return check('ok', 'open-PR digest job not configured');

  const status = readJsonFile<OpenPrDigestRunStatus>(statusPath);
  if (!status) return check('warn', `open-PR digest status missing at ${statusPath}`);
  if (!status.runAtIso) return check('warn', `open-PR digest status missing runAtIso at ${statusPath}`);

  const ageMinutes = minutesBetween(now, status.runAtIso);
  if (ageMinutes > 30 * 60) {
    return check('warn', `open-PR digest last ran ${status.runAtIso} (${ageMinutes}m ago)`);
  }

  if (status.status === 'ok' && status.deliveryOk === true) {
    return check('ok', `open-PR digest ok at ${status.runAtIso}; ${status.digestChars ?? 0} chars; message ${status.deliveryMessageId ?? 'unknown'}`);
  }

  const reason = status.reason ?? 'unknown';
  const detail = `open-PR digest ${status.status ?? 'unknown'} at ${status.runAtIso}; reason=${reason}; sweepExit=${status.sweepExitCode ?? 'unknown'}; deliveryOk=${status.deliveryOk}`;
  return check(reason === 'delivery_failed' ? 'error' : 'warn', detail);
}

function schedulerHeartbeatCheck(schedulerRoot: string, now: Date): HealthCheck {
  const heartbeatPath = path.join(schedulerRoot, '.scheduler-heartbeat');
  const heartbeat = readJsonFile<{ lastTickAt?: string; tickCount?: number }>(heartbeatPath);
  if (!heartbeat?.lastTickAt) {
    return check('warn', 'scheduler heartbeat missing - daemon may not have ticked yet or file is unreadable');
  }

  const lastTickMs = new Date(heartbeat.lastTickAt).getTime();
  if (!Number.isFinite(lastTickMs)) {
    return check('warn', `scheduler heartbeat invalid lastTickAt=${heartbeat.lastTickAt}`);
  }

  const staleMs = now.getTime() - lastTickMs;
  const staleSec = Math.round(staleMs / 1000);
  if (staleMs > 5 * 60_000) {
    return check('error', `scheduler heartbeat stale ${staleSec}s - tick() appears to have stopped (tick #${heartbeat.tickCount ?? '?'})`);
  }
  if (staleMs > 2 * 60_000) {
    return check('warn', `scheduler heartbeat stale ${staleSec}s - tick() may be delayed`);
  }
  return check('ok', `scheduler heartbeat fresh (${staleSec}s ago, tick #${heartbeat.tickCount ?? '?'})`);
}

function buildSchedulerHealth(schedulerRoot: string, now: Date, openPrDigestStatusPath: string): SchedulerHealth {
  const jobsFile = path.join(schedulerRoot, 'jobs.json');
  const logsDir = path.join(schedulerRoot, 'logs');
  const jobs = loadSchedulerJobs(schedulerRoot).filter((job) => job.enabled !== false);
  const validJobTypes = loadSchedulerValidJobTypes(schedulerRoot);
  const validTypes = new Set(validJobTypes);
  const invalidTypeJobs = jobs
    .filter((job) => !validTypes.has(job.type ?? ''))
    .map((job) => ({
      id: job.id ?? 'unknown',
      label: job.label ?? 'unlabeled',
      type: job.type ?? 'missing',
    }));

  const staleOneShotJobs = jobs
    .filter((job) => job.type === 'once' && job.fireAt)
    .map((job) => ({ job, staleMinutes: minutesBetween(now, job.fireAt ?? '') }))
    .filter(({ staleMinutes }) => staleMinutes > 5)
    .map(({ job, staleMinutes }) => ({
      id: job.id ?? 'unknown',
      label: job.label ?? 'unlabeled',
      fireAt: job.fireAt ?? '',
      staleMinutes,
    }));

  const staleRecurringJobs = jobs
    .filter((job) => job.type === 'recurring' && job.cron)
    .flatMap((job) => {
      const period = cronPeriodMs(job.cron ?? '');
      if (!period) {
        return [{
          id: job.id ?? 'unknown',
          label: job.label ?? 'unlabeled',
          cron: job.cron ?? '',
          reason: 'cron period could not be estimated',
        }];
      }
      const lastLogAt = latestLogMtimeForJob(logsDir, job.id ?? '');
      if (!lastLogAt) {
        return [{
          id: job.id ?? 'unknown',
          label: job.label ?? 'unlabeled',
          cron: job.cron ?? '',
          reason: 'no job log found',
        }];
      }
      const staleMs = now.getTime() - new Date(lastLogAt).getTime();
      if (staleMs <= period * 2) return [];
      return [{
        id: job.id ?? 'unknown',
        label: job.label ?? 'unlabeled',
        cron: job.cron ?? '',
        lastLogAt,
        staleHours: Math.round(staleMs / 36_000) / 100,
        reason: 'last log older than 2x estimated cron period',
      }];
    });

  return {
    jobsFile,
    validJobTypes,
    jobCount: jobs.length,
    invalidTypeJobs,
    staleOneShotJobs,
    staleRecurringJobs,
    checks: {
      jobTypes: validJobTypes.length === 0
        ? check('error', 'scheduler job-types contract is missing or empty')
        : invalidTypeJobs.length === 0
        ? check('ok', `all ${jobs.length} enabled jobs use valid types`)
        : check('error', `${invalidTypeJobs.length} job(s) use invalid type`),
      staleOneShots: staleOneShotJobs.length === 0
        ? check('ok', 'no stale fired one-shot jobs')
        : check('error', `${staleOneShotJobs.length} one-shot job(s) are past fireAt by >5min`),
      staleRecurring: staleRecurringJobs.length === 0
        ? check('ok', 'recurring jobs have recent logs where estimable')
        : check('warn', `${staleRecurringJobs.length} recurring job(s) have stale or missing logs`),
      schedulerHeartbeat: schedulerHeartbeatCheck(schedulerRoot, now),
      openPrDigest: openPrDigestStatusCheck(jobs, openPrDigestStatusPath, now),
    },
  };
}

function parseEnvFile(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
  return env;
}

async function fetchOpenBrainRows(): Promise<ThoughtRow[]> {
  const envPath = process.env.OPEN_BRAIN_ENV_PATH ?? DEFAULT_OPEN_BRAIN_ENV_PATH;
  const env = parseEnvFile(fs.readFileSync(envPath, 'utf8'));
  const projectUrl = env.SUPABASE_PROJECT_URL;
  const secretKey = env.SUPABASE_SECRET_KEY;
  if (!projectUrl || !secretKey) throw new Error(`Missing SUPABASE_PROJECT_URL or SUPABASE_SECRET_KEY in ${envPath}`);

  const url = new URL('/rest/v1/thoughts', projectUrl);
  url.searchParams.set('select', 'created_at,metadata');
  url.searchParams.set('order', 'created_at.desc');
  url.searchParams.set('limit', '2000');
  const response = await fetch(url, {
    headers: {
      apikey: secretKey,
      Authorization: `Bearer ${secretKey}`,
    },
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Open Brain health query failed: ${response.status} ${body}`);
  return JSON.parse(body) as ThoughtRow[];
}

function agentForRow(row: ThoughtRow): string {
  return row.metadata?.owner_agent ?? row.metadata?.agent_id ?? 'unknown';
}

function unresolvedRawCapture(row: ThoughtRow): boolean {
  return row.metadata?.scope === 'raw_capture' && !row.metadata.grooming_status;
}

async function probeOpenBrainSearch(agent: string, timeoutMs: number): Promise<HealthCheck> {
  const config = resolveOpenBrainRuntimeConfig(agent);
  if (!config) return check('unknown', 'OB1 runtime config missing; search not attempted');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(config.endpointUrl, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
        'x-agent-memory-key': config.agentMemoryKey,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: `runtime-health-${agent}-${Date.now()}`,
        method: 'tools/call',
        params: {
          name: 'search_agent_memory',
          arguments: {
            agent_key: config.agentMemoryKey,
            agent_id: config.agentId,
            query: `${agent} runtime health probe`,
            limit: 1,
            threshold: 0.1,
          },
        },
      }),
    });
    if (!response.ok) {
      const body = await response.text();
      return check('error', `search probe failed: ${response.status} ${body}`);
    }
    const body = await response.text();
    if (body.includes('"isError":true')) {
      return check('error', `search probe returned MCP error: ${body.slice(0, 500)}`);
    }
    return check('ok', `search probe succeeded at ${new Date().toISOString()}`);
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return check('unknown', `search probe timed out after ${timeoutMs}ms`);
    }
    return check('error', `search probe failed: ${String(error)}`);
  } finally {
    clearTimeout(timeout);
  }
}

function buildAgentMailHealth(agentMailDbPath: string, outboxPath: string, agents: string[], now: Date): AgentMailHealth {
  const agentStats: AgentMailHealth['agents'] = {};
  for (const agent of agents) {
    agentStats[agent] = { inboxDepth: 0 };
  }

  try {
    const db = new Database(agentMailDbPath, { readonly: true, fileMustExist: true });
    try {
      const rows = db.prepare(`
        select to_agent as agent, count(*) as inboxDepth, min(created_at) as oldestUnackedAt
        from messages
        where status != 'closed' and acked_at is null
        group by to_agent
      `).all() as Array<{ agent: string; inboxDepth: number; oldestUnackedAt?: string }>;
      for (const row of rows) {
        if (!agentStats[row.agent]) agentStats[row.agent] = { inboxDepth: 0 };
        agentStats[row.agent] = {
          inboxDepth: Number(row.inboxDepth),
          oldestUnackedAt: row.oldestUnackedAt,
          oldestUnackedAgeMinutes: row.oldestUnackedAt ? minutesBetween(now, row.oldestUnackedAt) : undefined,
        };
      }
    } finally {
      db.close();
    }
  } catch {
    for (const agent of agents) {
      agentStats[agent] = { inboxDepth: 0 };
    }
  }

  const outboxMtime = fileMtimeIso(outboxPath);
  return {
    dbPath: agentMailDbPath,
    agents: agentStats,
    outbox: outboxMtime
      ? check('ok', `scheduled Discord outbox last updated ${outboxMtime}`)
      : check('unknown', `scheduled Discord outbox not found at ${outboxPath}`),
  };
}

function buildAgentHealth(
  agent: string,
  agentsRoot: string,
  rows: ThoughtRow[] | null,
  searchCheck: HealthCheck,
  mailStats: AgentMailHealth['agents'][string] | undefined,
  codexConfigPath: string,
  contentRoot: string,
  now: Date,
): AgentRuntimeHealth {
  const agentRoot = path.join(agentsRoot, agent);
  const runtime = readTrimmed(path.join(agentRoot, '.runtime'));
  const discordAccess = path.join(agentRoot, '.claude', 'discord', 'access.json');
  const discordEnv = path.join(agentRoot, '.claude', 'discord', '.env');
  const ob1Env = path.join(agentRoot, '.open-brain', 'memory.env');
  const hasDiscordConfig = fileExists(discordAccess) && fileExists(discordEnv) && hasDiscordChannels(discordAccess);
  const isCodex = runtime === 'codex';
  const agentRows = rows?.filter((row) => agentForRow(row) === agent) ?? [];
  const lastCapture = agentRows[0]?.created_at;
  const queueDepth = agentRows.filter(unresolvedRawCapture).length;
  const oldestUnacked = mailStats?.oldestUnackedAt
    ? `; oldest unacked ${mailStats.oldestUnackedAt} (${mailStats.oldestUnackedAgeMinutes}m)`
    : '';

  return {
    agent,
    runtimeLaunchConfig: runtimeLaunchConfigCheck(agent, agentsRoot),
    runtimeType: runtime
      ? check(runtime === 'claude' || runtime === 'codex' ? 'ok' : 'warn', runtime)
      : check('unknown', '.runtime file missing'),
    discordBridgeConfig: fileExists(discordAccess) && fileExists(discordEnv)
      ? hasDiscordChannels(discordAccess)
        ? check('ok', 'Discord access.json and .env present with allowed channel(s)')
        : check('warn', 'Discord access.json has no allowed channel groups')
      : check('warn', `missing ${fileExists(discordAccess) ? '' : 'access.json '}${fileExists(discordEnv) ? '' : '.env'}`.trim()),
    codexInboundBridge: hasDiscordConfig
      ? codexInboundBridgeCheck(agent, contentRoot)
      : check('ok', 'no Discord channels configured'),
    discordInboxDelivery: discordInboxDeliveryCheck(agent, contentRoot, now, hasDiscordConfig),
    codexOutboundDiscordMcp: isCodex && hasDiscordConfig
      ? codexDiscordMcpCheck(agent, agentsRoot, codexConfigPath)
      : check('ok', isCodex ? 'no Discord channels configured' : 'not a Codex runtime'),
    discordOutboundMcp: discordOutboundMcpCheck(agent, runtime, agentsRoot, codexConfigPath, contentRoot, hasDiscordConfig),
    openBrainMemoryKey: fileExists(ob1Env)
      ? check('ok', '.open-brain/memory.env present')
      : check('warn', '.open-brain/memory.env missing'),
    lastOpenBrainCapture: rows === null
      ? check('unknown', 'OB1 capture metadata unavailable')
      : lastCapture
        ? check('ok', lastCapture)
        : check('unknown', 'no capture found in recent OB1 rows'),
    lastOpenBrainSearch: searchCheck,
    groomingQueueDepth: rows === null
      ? check('unknown', 'OB1 grooming queue unavailable')
      : queueDepth === 0
        ? check('ok', '0 unresolved raw_capture rows in recent window')
        : check('warn', `${queueDepth} unresolved raw_capture row(s) in recent window`),
    agentMail: check((mailStats?.inboxDepth ?? 0) > 0 ? 'warn' : 'ok', `${mailStats?.inboxDepth ?? 0} unacked inbox item(s)${oldestUnacked}`),
    skillSnapshot: skillSnapshotCheck(agent, agentsRoot),
    preSessionContext: preSessionContextCheck(agent, contentRoot),
    migrationReadiness: check('unknown', 'pending'),
  };
}

export async function buildRuntimeHealthReport(options: RuntimeHealthOptions = {}): Promise<RuntimeHealthReport> {
  const startedAt = Date.now();
  const now = options.now ?? new Date();
  const agentsRoot = options.agentsRoot ?? DEFAULT_AGENTS_ROOT;
  const schedulerRoot = options.schedulerRoot ?? DEFAULT_SCHEDULER_ROOT;
  const agents = resolveAgents({ ...options, agentsRoot });
  const scheduler = buildSchedulerHealth(
    schedulerRoot,
    now,
    options.openPrDigestStatusPath ?? DEFAULT_OPEN_PR_DIGEST_STATUS_PATH,
  );
  const agentMail = buildAgentMailHealth(
    options.agentMailDbPath ?? DEFAULT_AGENT_MAIL_DB,
    options.scheduledOutboxPath ?? DEFAULT_SCHEDULED_OUTBOX,
    agents,
    now,
  );

  let rows: ThoughtRow[] | null = null;
  if (options.includeOpenBrainMetadata !== false) {
    try {
      rows = await fetchOpenBrainRows();
    } catch {
      rows = null;
    }
  }

  const includeSearch = options.includeOpenBrainSearch !== false;
  const searchChecks = new Map<string, HealthCheck>();
  await Promise.all(agents.map(async (agent) => {
    searchChecks.set(agent, includeSearch
      ? await probeOpenBrainSearch(agent, options.openBrainSearchTimeoutMs ?? 1000)
      : check('unknown', 'search probe skipped'));
  }));

  const agentHealth = agents.map((agent) => buildAgentHealth(
    agent,
    agentsRoot,
    rows,
    searchChecks.get(agent) ?? check('unknown', 'search probe missing'),
    agentMail.agents[agent],
    options.codexConfigPath ?? DEFAULT_CODEX_CONFIG_PATH,
    options.contentRoot ?? DEFAULT_CONTENT_ROOT,
    now,
  ));
  for (const agent of agentHealth) {
    agent.migrationReadiness = evaluateMigrationReadiness(agent);
  }

  const allChecks = [
    scheduler.checks.jobTypes,
    scheduler.checks.staleOneShots,
    scheduler.checks.staleRecurring,
    scheduler.checks.schedulerHeartbeat,
    scheduler.checks.openPrDigest,
    agentMail.outbox,
    ...agentHealth.flatMap((agent) => [
      agent.runtimeLaunchConfig,
      agent.runtimeType,
      agent.discordBridgeConfig,
      agent.codexInboundBridge,
      agent.discordInboxDelivery,
      agent.codexOutboundDiscordMcp,
      agent.discordOutboundMcp,
      agent.openBrainMemoryKey,
      agent.lastOpenBrainCapture,
      agent.lastOpenBrainSearch,
      agent.groomingQueueDepth,
      agent.agentMail,
      agent.skillSnapshot,
      agent.preSessionContext,
    ]),
  ];
  const status = worstStatus(allChecks);

  return {
    generatedAtIso: now.toISOString(),
    durationMs: Date.now() - startedAt,
    agents: agentHealth,
    scheduler,
    agentMail,
    summary: check(status, `${allChecks.filter((item) => item.status !== 'ok').length} non-ok check(s)`),
  };
}

export function formatRuntimeHealthSummary(report: RuntimeHealthReport): string {
  const lines = [
    `OB1/runtime health - ${report.generatedAtIso}`,
    `Status: ${report.summary.status.toUpperCase()} (${report.summary.detail})`,
    `Duration: ${report.durationMs}ms`,
    '',
    'Agents:',
  ];

  for (const agent of report.agents) {
    const checks = [
      `launcher=${agent.runtimeLaunchConfig.status}:${agent.runtimeLaunchConfig.detail}`,
      `runtime=${agent.runtimeType.status}:${agent.runtimeType.detail}`,
      `discord=${agent.discordBridgeConfig.status}`,
      `codex-in=${agent.codexInboundBridge.status}:${agent.codexInboundBridge.detail}`,
      `delivery=${agent.discordInboxDelivery.status}:${agent.discordInboxDelivery.detail}`,
      `discord-out=${agent.discordOutboundMcp.status}:${agent.discordOutboundMcp.detail}`,
      `ob1-key=${agent.openBrainMemoryKey.status}`,
      `capture=${agent.lastOpenBrainCapture.status}:${agent.lastOpenBrainCapture.detail}`,
      `search=${agent.lastOpenBrainSearch.status}:${agent.lastOpenBrainSearch.detail}`,
      `grooming=${agent.groomingQueueDepth.status}:${agent.groomingQueueDepth.detail}`,
      `mail=${agent.agentMail.status}:${agent.agentMail.detail}`,
      `skills=${agent.skillSnapshot.status}:${agent.skillSnapshot.detail}`,
      `pre-session=${agent.preSessionContext.status}:${agent.preSessionContext.detail}`,
      `migration=${agent.migrationReadiness.status}:${agent.migrationReadiness.detail}`,
    ];
    lines.push(`- ${agent.agent}: ${checks.join('; ')}`);
  }

  lines.push('');
  lines.push('Scheduler:');
  lines.push(`- jobs: ${report.scheduler.jobCount}`);
  lines.push(`- valid types: ${report.scheduler.validJobTypes.join(', ')}`);
  lines.push(`- type check: ${report.scheduler.checks.jobTypes.status} - ${report.scheduler.checks.jobTypes.detail}`);
  lines.push(`- stale one-shots: ${report.scheduler.checks.staleOneShots.status} - ${report.scheduler.checks.staleOneShots.detail}`);
  lines.push(`- recurring logs: ${report.scheduler.checks.staleRecurring.status} - ${report.scheduler.checks.staleRecurring.detail}`);
  lines.push(`- heartbeat: ${report.scheduler.checks.schedulerHeartbeat.status} - ${report.scheduler.checks.schedulerHeartbeat.detail}`);
  lines.push(`- open-PR digest: ${report.scheduler.checks.openPrDigest.status} - ${report.scheduler.checks.openPrDigest.detail}`);
  for (const job of report.scheduler.invalidTypeJobs.slice(0, 8)) {
    lines.push(`  invalid type: ${job.id} (${job.label}) type=${job.type}`);
  }
  for (const job of report.scheduler.staleOneShotJobs.slice(0, 8)) {
    lines.push(`  stale once: ${job.id} (${job.label}) fireAt=${job.fireAt} stale=${job.staleMinutes}m`);
  }

  lines.push('');
  lines.push(`Agent-mail outbox: ${report.agentMail.outbox.status} - ${report.agentMail.outbox.detail}`);
  return lines.join('\n');
}
