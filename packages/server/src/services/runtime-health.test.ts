import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildRuntimeHealthReport,
  diskSpaceHealthFromKilobytes,
  formatRuntimeHealthSummary,
  loadSchedulerValidJobTypes,
  renderStaleOneShots,
} from './runtime-health.js';

const tempRoots: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-health-'));
  tempRoots.push(dir);
  return dir;
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.AGENTS_ROOT;
  delete process.env.OPEN_BRAIN_ENV_PATH;
  delete process.env.OPEN_BRAIN_ACCESS_KEY_PATH;
  delete process.env.DISCORD_BRIDGE_SOCKET_PATH;
  for (const dir of tempRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('runtime health', () => {
  it('classifies root disk free-space thresholds', () => {
    expect(diskSpaceHealthFromKilobytes('/', 200 * 1024 * 1024, 20 * 1024 * 1024).status).toBe('ok');
    expect(diskSpaceHealthFromKilobytes('/', 228 * 1024 * 1024, 11 * 1024 * 1024).status).toBe('warn');
    expect(diskSpaceHealthFromKilobytes('/', 228 * 1024 * 1024, 470 * 1024).status).toBe('error');
  });

  it('loads scheduler valid job types from the shared scheduler contract', () => {
    const root = tempDir();
    writeJson(path.join(root, 'job-types.json'), { validTypes: ['once', 'recurring'] });

    expect(loadSchedulerValidJobTypes(root)).toEqual(['once', 'recurring']);
  });

  it('flags invalid scheduler type one-shot from jobs.json', async () => {
    const root = tempDir();
    const schedulerRoot = path.join(root, 'scheduler');
    const agentsRoot = path.join(root, 'agents');
    const agentMailDbPath = path.join(root, 'missing-agent-mail.db');
    writeJson(path.join(schedulerRoot, 'job-types.json'), { validTypes: ['once', 'recurring'] });
    writeJson(path.join(schedulerRoot, 'jobs.json'), {
      jobs: [{
        id: 'bad-loop',
        label: 'Phase 1 shakedown',
        agent: 'eli',
        type: 'one-shot',
        fireAt: '2026-05-07T13:00:00.000Z',
      }],
    });
    fs.mkdirSync(path.join(schedulerRoot, 'logs'), { recursive: true });
    fs.mkdirSync(path.join(agentsRoot, 'eli'), { recursive: true });
    fs.writeFileSync(path.join(agentsRoot, 'eli', 'launch.sh'), '#!/bin/zsh\n');
    fs.writeFileSync(path.join(agentsRoot, 'eli', '.runtime'), 'codex\n');

    const report = await buildRuntimeHealthReport({
      agents: ['eli'],
      agentsRoot,
      schedulerRoot,
      agentMailDbPath,
      scheduledOutboxPath: path.join(root, 'outbox.jsonl'),
      now: new Date('2026-05-07T21:00:00.000Z'),
      includeOpenBrainSearch: false,
      includeOpenBrainMetadata: false,
    });

    expect(report.scheduler.checks.jobTypes.status).toBe('error');
    expect(report.scheduler.invalidTypeJobs).toEqual([{
      id: 'bad-loop',
      label: 'Phase 1 shakedown',
      type: 'one-shot',
    }]);
    expect(report.summary.status).toBe('error');
  });

  it('surfaces a recent off-process notification-runner failure and ignores archival failures', async () => {
    const root = tempDir();
    const schedulerRoot = path.join(root, 'scheduler');
    const logsDir = path.join(schedulerRoot, 'logs');
    const now = new Date('2026-10-30T12:00:00.000Z');
    writeJson(path.join(schedulerRoot, 'job-types.json'), { validTypes: ['once', 'recurring'] });
    writeJson(path.join(schedulerRoot, 'jobs.json'), { jobs: [] });
    writeJson(path.join(logsDir, 'live-job-2026-10-30T10-00-00.notification-failure.json'), {
      severity: 'critical',
      jobId: 'live-job',
      agent: 'lena',
      // The producer writes the scheduled fire time here, not the failure moment. The
      // monitor must use mtime, which this fixture controls independently below.
      timestamp: '2026-10-30T09:55:00.000Z',
      reason: 'notification runner exited with code 1',
    });
    writeJson(path.join(logsDir, 'archival-job-2026-10-01T10-00-00.notification-failure.json'), {
      severity: 'critical', jobId: 'archival-job', reason: 'old failure',
    });
    fs.utimesSync(
      path.join(logsDir, 'live-job-2026-10-30T10-00-00.notification-failure.json'),
      now.getTime() / 1000 - 60,
      now.getTime() / 1000 - 60,
    );
    fs.utimesSync(
      path.join(logsDir, 'archival-job-2026-10-01T10-00-00.notification-failure.json'),
      now.getTime() / 1000 - 40 * 60 * 60,
      now.getTime() / 1000 - 40 * 60 * 60,
    );

    const report = await buildRuntimeHealthReport({
      agents: [], schedulerRoot, agentMailDbPath: path.join(root, 'missing.db'), now,
      includeOpenBrainSearch: false, includeOpenBrainMetadata: false,
    });

    expect(report.scheduler.notificationDeliveryFailures).toEqual([expect.objectContaining({
      jobId: 'live-job', agent: 'lena', reason: 'notification runner exited with code 1',
      failedAt: '2026-10-30T11:59:00.000Z',
    })]);
    expect(report.scheduler.checks.notificationDelivery).toEqual(expect.objectContaining({
      status: 'error',
      detail: expect.stringContaining('live-job: notification runner exited with code 1'),
    }));
    expect(formatRuntimeHealthSummary(report)).toContain('- notification delivery: error');
  });

  it('reports notification delivery as unknown when its artifact directory is unreadable', async () => {
    const root = tempDir();
    const schedulerRoot = path.join(root, 'scheduler');
    writeJson(path.join(schedulerRoot, 'job-types.json'), { validTypes: ['once', 'recurring'] });
    writeJson(path.join(schedulerRoot, 'jobs.json'), { jobs: [] });

    const report = await buildRuntimeHealthReport({
      agents: [], schedulerRoot, agentMailDbPath: path.join(root, 'missing.db'),
      now: new Date('2026-10-30T12:00:00.000Z'),
      includeOpenBrainSearch: false, includeOpenBrainMetadata: false,
    });

    expect(report.scheduler.checks.notificationDelivery.status).toBe('unknown');
    expect(report.scheduler.checks.notificationDelivery.detail).toContain('log directory unreadable');
  });

  it('renders the Discord-postable summary from JSON report data', async () => {
    const root = tempDir();
    const schedulerRoot = path.join(root, 'scheduler');
    const agentsRoot = path.join(root, 'agents');
    writeJson(path.join(schedulerRoot, 'job-types.json'), { validTypes: ['once', 'recurring'] });
    writeJson(path.join(schedulerRoot, 'jobs.json'), { jobs: [] });
    fs.mkdirSync(path.join(schedulerRoot, 'logs'), { recursive: true });
    fs.mkdirSync(path.join(agentsRoot, 'eli'), { recursive: true });
    fs.writeFileSync(path.join(agentsRoot, 'eli', 'launch.sh'), '#!/bin/zsh\n');
    fs.writeFileSync(path.join(agentsRoot, 'eli', '.runtime'), 'codex\n');

    const report = await buildRuntimeHealthReport({
      agents: ['eli'],
      agentsRoot,
      schedulerRoot,
      agentMailDbPath: path.join(root, 'missing-agent-mail.db'),
      scheduledOutboxPath: path.join(root, 'outbox.jsonl'),
      now: new Date('2026-05-07T21:00:00.000Z'),
      includeOpenBrainSearch: false,
      includeOpenBrainMetadata: false,
    });
    const summary = formatRuntimeHealthSummary(report);

    expect(summary).toContain('OB1/runtime health - 2026-05-07T21:00:00.000Z');
    expect(summary).toContain('Agents:');
    expect(summary).toContain('- eli:');
    expect(summary).toContain('System:');
    expect(summary).toContain('- disk root:');
    expect(summary).toContain('Scheduler:');
  });

  // Regression: 2026-05-31 newsletter miss. launchd can keep the daemon process
  // alive while scheduler tick() stops silently; runtime-health must surface that.
  it('reports scheduler heartbeat ok when the tick file is fresh', async () => {
    const root = tempDir();
    const schedulerRoot = path.join(root, 'scheduler');
    const now = new Date('2026-05-31T07:20:00.000Z');
    writeJson(path.join(schedulerRoot, 'job-types.json'), { validTypes: ['once', 'recurring'] });
    writeJson(path.join(schedulerRoot, 'jobs.json'), { jobs: [] });
    writeJson(path.join(schedulerRoot, '.scheduler-heartbeat'), {
      lastTickAt: new Date(now.getTime() - 30_000).toISOString(),
      tickCount: 42,
    });
    fs.mkdirSync(path.join(schedulerRoot, 'logs'), { recursive: true });

    const report = await buildRuntimeHealthReport({
      agents: [],
      schedulerRoot,
      agentMailDbPath: path.join(root, 'missing.db'),
      now,
      includeOpenBrainSearch: false,
      includeOpenBrainMetadata: false,
    });

    expect(report.scheduler.checks.schedulerHeartbeat.status).toBe('ok');
    expect(report.scheduler.checks.schedulerHeartbeat.detail).toContain('30s');
  });

  it('reports scheduler heartbeat warn when stale 3 minutes', async () => {
    const root = tempDir();
    const schedulerRoot = path.join(root, 'scheduler');
    const now = new Date('2026-05-31T07:20:00.000Z');
    writeJson(path.join(schedulerRoot, 'job-types.json'), { validTypes: ['once', 'recurring'] });
    writeJson(path.join(schedulerRoot, 'jobs.json'), { jobs: [] });
    writeJson(path.join(schedulerRoot, '.scheduler-heartbeat'), {
      lastTickAt: new Date(now.getTime() - 3 * 60_000).toISOString(),
      tickCount: 10,
    });
    fs.mkdirSync(path.join(schedulerRoot, 'logs'), { recursive: true });

    const report = await buildRuntimeHealthReport({
      agents: [],
      schedulerRoot,
      agentMailDbPath: path.join(root, 'missing.db'),
      now,
      includeOpenBrainSearch: false,
      includeOpenBrainMetadata: false,
    });

    expect(report.scheduler.checks.schedulerHeartbeat.status).toBe('warn');
  });

  it('reports scheduler heartbeat error when stale 6 minutes', async () => {
    const root = tempDir();
    const schedulerRoot = path.join(root, 'scheduler');
    const now = new Date('2026-05-31T07:20:00.000Z');
    writeJson(path.join(schedulerRoot, 'job-types.json'), { validTypes: ['once', 'recurring'] });
    writeJson(path.join(schedulerRoot, 'jobs.json'), { jobs: [] });
    writeJson(path.join(schedulerRoot, '.scheduler-heartbeat'), {
      lastTickAt: new Date(now.getTime() - 6 * 60_000).toISOString(),
      tickCount: 5,
    });
    fs.mkdirSync(path.join(schedulerRoot, 'logs'), { recursive: true });

    const report = await buildRuntimeHealthReport({
      agents: [],
      schedulerRoot,
      agentMailDbPath: path.join(root, 'missing.db'),
      now,
      includeOpenBrainSearch: false,
      includeOpenBrainMetadata: false,
    });

    expect(report.scheduler.checks.schedulerHeartbeat.status).toBe('error');
    expect(report.scheduler.checks.schedulerHeartbeat.detail).toContain('tick() appears to have stopped');
  });

  it('reports scheduler heartbeat warn when the tick file is missing', async () => {
    const root = tempDir();
    const schedulerRoot = path.join(root, 'scheduler');
    writeJson(path.join(schedulerRoot, 'job-types.json'), { validTypes: ['once', 'recurring'] });
    writeJson(path.join(schedulerRoot, 'jobs.json'), { jobs: [] });
    fs.mkdirSync(path.join(schedulerRoot, 'logs'), { recursive: true });

    const report = await buildRuntimeHealthReport({
      agents: [],
      schedulerRoot,
      agentMailDbPath: path.join(root, 'missing.db'),
      now: new Date('2026-05-31T07:20:00.000Z'),
      includeOpenBrainSearch: false,
      includeOpenBrainMetadata: false,
    });

    expect(report.scheduler.checks.schedulerHeartbeat.status).toBe('warn');
    expect(report.scheduler.checks.schedulerHeartbeat.detail).toContain('missing');
  });

  it('warns when the configured open-PR digest last run was a partial failure', async () => {
    const root = tempDir();
    const schedulerRoot = path.join(root, 'scheduler');
    const agentsRoot = path.join(root, 'agents');
    const statusPath = path.join(root, 'open-pr-digest-status.json');
    writeJson(path.join(schedulerRoot, 'job-types.json'), { validTypes: ['once', 'recurring'] });
    writeJson(path.join(schedulerRoot, 'jobs.json'), {
      jobs: [{
        id: 'open-pr-digest-daily',
        label: 'Daily open-PR digest to #dev',
        agent: 'marcus',
        type: 'recurring',
        cron: '0 9 * * *',
        executor: 'shell',
        command: 'node /Volumes/Repo-Drive/src/mcc-tmux/scripts/run-open-pr-digest.mjs',
      }],
    });
    fs.mkdirSync(path.join(schedulerRoot, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(schedulerRoot, 'logs', 'open-pr-digest-daily-2026-07-19T13-00-00.log'), 'ran\n');
    fs.mkdirSync(path.join(agentsRoot, 'marcus'), { recursive: true });
    fs.writeFileSync(path.join(agentsRoot, 'marcus', 'launch.sh'), '#!/bin/zsh\nnpm run runtime-launch --agent marcus --runtime "$LAUNCH_RUNTIME"\n');
    fs.writeFileSync(path.join(agentsRoot, 'marcus', '.runtime'), 'claude\n');
    writeJson(statusPath, {
      runAtIso: '2026-07-19T13:00:00.000Z',
      status: 'fail',
      reason: 'partial_failure',
      sweepExitCode: 1,
      deliveryOk: true,
      digestChars: 500,
      deliveryMessageId: 'm1',
    });

    const report = await buildRuntimeHealthReport({
      agents: ['marcus'],
      agentsRoot,
      schedulerRoot,
      agentMailDbPath: path.join(root, 'missing.db'),
      scheduledOutboxPath: path.join(root, 'outbox.jsonl'),
      openPrDigestStatusPath: statusPath,
      now: new Date('2026-07-19T14:00:00.000Z'),
      includeOpenBrainSearch: false,
      includeOpenBrainMetadata: false,
    });

    expect(report.scheduler.checks.openPrDigest.status).toBe('warn');
    expect(report.scheduler.checks.openPrDigest.detail).toContain('reason=partial_failure');
  });

  it('errors when the configured open-PR digest could not deliver to Discord', async () => {
    const root = tempDir();
    const schedulerRoot = path.join(root, 'scheduler');
    const agentsRoot = path.join(root, 'agents');
    const statusPath = path.join(root, 'open-pr-digest-status.json');
    writeJson(path.join(schedulerRoot, 'job-types.json'), { validTypes: ['once', 'recurring'] });
    writeJson(path.join(schedulerRoot, 'jobs.json'), {
      jobs: [{
        id: 'open-pr-digest-daily',
        label: 'Daily open-PR digest to #dev',
        agent: 'marcus',
        type: 'recurring',
        cron: '0 9 * * *',
        executor: 'shell',
        command: 'node /Volumes/Repo-Drive/src/mcc-tmux/scripts/run-open-pr-digest.mjs',
      }],
    });
    fs.mkdirSync(path.join(schedulerRoot, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(schedulerRoot, 'logs', 'open-pr-digest-daily-2026-07-19T13-00-00.log'), 'ran\n');
    fs.mkdirSync(path.join(agentsRoot, 'marcus'), { recursive: true });
    fs.writeFileSync(path.join(agentsRoot, 'marcus', 'launch.sh'), '#!/bin/zsh\nnpm run runtime-launch --agent marcus --runtime "$LAUNCH_RUNTIME"\n');
    fs.writeFileSync(path.join(agentsRoot, 'marcus', '.runtime'), 'claude\n');
    writeJson(statusPath, {
      runAtIso: '2026-07-19T13:00:00.000Z',
      status: 'fail',
      reason: 'delivery_failed',
      sweepExitCode: 0,
      deliveryOk: false,
      digestChars: 500,
    });

    const report = await buildRuntimeHealthReport({
      agents: ['marcus'],
      agentsRoot,
      schedulerRoot,
      agentMailDbPath: path.join(root, 'missing.db'),
      scheduledOutboxPath: path.join(root, 'outbox.jsonl'),
      openPrDigestStatusPath: statusPath,
      now: new Date('2026-07-19T14:00:00.000Z'),
      includeOpenBrainSearch: false,
      includeOpenBrainMetadata: false,
    });

    expect(report.scheduler.checks.openPrDigest.status).toBe('error');
    expect(report.scheduler.checks.openPrDigest.detail).toContain('reason=delivery_failed');
    expect(report.summary.status).toBe('error');
  });

  it('flags Codex agents with Discord channels but missing adapter surfaces', async () => {
    const root = tempDir();
    const schedulerRoot = path.join(root, 'scheduler');
    const agentsRoot = path.join(root, 'agents');
    const agentRoot = path.join(agentsRoot, 'pilot');
    writeJson(path.join(schedulerRoot, 'job-types.json'), { validTypes: ['once', 'recurring'] });
    writeJson(path.join(schedulerRoot, 'jobs.json'), { jobs: [] });
    fs.mkdirSync(path.join(schedulerRoot, 'logs'), { recursive: true });
    fs.mkdirSync(path.join(agentRoot, '.claude', 'discord'), { recursive: true });
    fs.mkdirSync(path.join(agentsRoot, 'SHARED', 'skills', 'runtime-canary'), { recursive: true });
    fs.writeFileSync(
      path.join(agentsRoot, 'SHARED', 'skills', 'runtime-canary', 'SKILL.md'),
      '---\nname: runtime-canary\ndescription: Runtime canary skill for agent isolation testing.\n---\nCanary.\n',
    );
    fs.writeFileSync(
      path.join(agentRoot, 'launch.sh'),
      '#!/bin/zsh\nnpm run runtime-launch --agent pilot --runtime "$LAUNCH_RUNTIME"\n',
    );
    fs.writeFileSync(path.join(agentRoot, '.runtime'), 'codex\n');
    process.env.DISCORD_BRIDGE_SOCKET_PATH = path.join(root, 'missing-discord-bridge.sock');
    fs.writeFileSync(path.join(agentRoot, '.claude', 'discord', '.env'), 'DISCORD_BOT_TOKEN=x\n');
    writeJson(path.join(agentRoot, '.claude', 'discord', 'access.json'), {
      groups: {
        '1234567890': { requireMention: false },
      },
    });

    const report = await buildRuntimeHealthReport({
      agents: ['pilot'],
      agentsRoot,
      schedulerRoot,
      agentMailDbPath: path.join(root, 'missing-agent-mail.db'),
      scheduledOutboxPath: path.join(root, 'outbox.jsonl'),
      codexConfigPath: path.join(root, 'missing-codex-config.toml'),
      contentRoot: path.join(root, 'content'),
      now: new Date('2026-05-12T01:45:00.000Z'),
      includeOpenBrainSearch: false,
      includeOpenBrainMetadata: false,
      diskCheck: { status: 'ok', detail: 'pinned by fixture' },
    });

    expect(report.agents[0].codexInboundBridge.status).toBe('warn');
    expect(report.agents[0].codexInboundBridge.detail).toContain('pilot-discord-bridge');
    expect(report.agents[0].codexOutboundDiscordMcp.status).toBe('warn');
    expect(report.agents[0].codexOutboundDiscordMcp.detail).toContain('Codex config missing');
    expect(report.agents[0].migrationReadiness.status).toBe('error');
    expect(report.agents[0].migrationReadiness.detail).toContain('ob1-key');
    // CORRECTED 2026-09-13. 5874cc8 flipped this to 'error' reasoning that migrationReadiness
    // (error, above) escalates the summary. It does not: migrationReadiness is not in the
    // summary's check list. What made the summary read 'error' was `system.diskRoot`, a LIVE
    // `df` of the machine's root disk, which was below the 2 GiB error floor when that commit
    // was verified and was not by the evening. The test was asserting free disk space. With
    // disk pinned, the worst included check is the Codex adapter 'warn'.
    expect(report.summary.status).toBe('warn');
  });

  // dc-20260914-001. The supervisor writes tick phase into the heartbeat every tick; these are
  // the reader's contracts. The planted over-threshold phase is the acceptance test: it has to
  // surface as a non-ok CHECK, not only as a line in a launchd log.
  it('reports an aligned tick phase as ok, and a planted stalled phase as a non-ok check that reaches the summary', async () => {
    const run = async (phaseMs: number) => {
      const root = tempDir();
      const schedulerRoot = path.join(root, 'scheduler');
      writeJson(path.join(schedulerRoot, 'job-types.json'), { validTypes: ['once', 'recurring'] });
      writeJson(path.join(schedulerRoot, 'jobs.json'), { jobs: [] });
      fs.mkdirSync(path.join(schedulerRoot, 'logs'), { recursive: true });
      const now = new Date('2026-09-19T13:00:30.000Z');
      writeJson(path.join(schedulerRoot, '.scheduler-heartbeat'), {
        lastTickAt: new Date(now.getTime() - 20_000).toISOString(), tickCount: 42, phaseMs, tickMs: 60_000,
      });
      return buildRuntimeHealthReport({
        agents: [], agentsRoot: path.join(root, 'agents'), schedulerRoot,
        agentMailDbPath: path.join(root, 'missing.db'), scheduledOutboxPath: path.join(root, 'outbox.jsonl'),
        now, includeOpenBrainSearch: false, includeOpenBrainMetadata: false,
        diskCheck: { status: 'ok', detail: 'pinned by fixture' },
      });
    };

    const aligned = await run(1_002);
    expect(aligned.scheduler.checks.schedulerTickPhase.status).toBe('ok');
    expect(aligned.scheduler.checks.schedulerTickPhase.detail).toContain('1002ms');
    // NOT asserting summary==='ok' here: with no agents configured other checks are already
    // 'unknown', so an aligned phase cannot make the summary ok. What matters is that a
    // non-ok PHASE reaches the summary, which the two cases below pin.
    expect(aligned.summary.status).not.toBe('warn');

    const stalled = await run(8_000);
    expect(stalled.scheduler.checks.schedulerTickPhase.status).toBe('warn');
    expect(stalled.scheduler.checks.schedulerTickPhase.detail).toContain('5000ms alignment threshold');
    expect(stalled.summary.status).toBe('warn');

    const wild = await run(40_000);
    expect(wild.scheduler.checks.schedulerTickPhase.status).toBe('error');
    expect(wild.scheduler.checks.schedulerTickPhase.detail).toContain('event-loop stall or clock jump');
    expect(wild.summary.status).toBe('error');

    expect(formatRuntimeHealthSummary(wild)).toContain('- tick phase: error');
  });

  it('never reports ok when the phase is absent or stale: unknown and ok must not look alike', async () => {
    const build = async (heartbeat: unknown) => {
      const root = tempDir();
      const schedulerRoot = path.join(root, 'scheduler');
      writeJson(path.join(schedulerRoot, 'job-types.json'), { validTypes: ['once', 'recurring'] });
      writeJson(path.join(schedulerRoot, 'jobs.json'), { jobs: [] });
      fs.mkdirSync(path.join(schedulerRoot, 'logs'), { recursive: true });
      if (heartbeat !== undefined) writeJson(path.join(schedulerRoot, '.scheduler-heartbeat'), heartbeat);
      return buildRuntimeHealthReport({
        agents: [], agentsRoot: path.join(root, 'agents'), schedulerRoot,
        agentMailDbPath: path.join(root, 'missing.db'), scheduledOutboxPath: path.join(root, 'outbox.jsonl'),
        now: new Date('2026-09-19T13:00:30.000Z'), includeOpenBrainSearch: false, includeOpenBrainMetadata: false,
        diskCheck: { status: 'ok', detail: 'pinned by fixture' },
      });
    };

    // No file at all -- the live state before the supervisor wrote one.
    expect((await build(undefined)).scheduler.checks.schedulerTickPhase.status).toBe('unknown');
    // An older supervisor: heartbeat without a phase.
    expect((await build({ lastTickAt: '2026-09-19T13:00:10.000Z', tickCount: 5 })).scheduler.checks.schedulerTickPhase.status).toBe('unknown');
    // A good-looking phase from a heartbeat nobody has updated for an hour describes the past.
    const stale = await build({ lastTickAt: '2026-09-19T12:00:10.000Z', phaseMs: 1_000, tickMs: 60_000 });
    expect(stale.scheduler.checks.schedulerTickPhase.status).toBe('unknown');
    expect(stale.scheduler.checks.schedulerTickPhase.detail).toContain('stale heartbeat');
  });

  it('scales the tick-phase staleness window to the tick, so a slow tick cannot make the check permanently unknown', async () => {
    const root = tempDir();
    const schedulerRoot = path.join(root, 'scheduler');
    writeJson(path.join(schedulerRoot, 'job-types.json'), { validTypes: ['once', 'recurring'] });
    writeJson(path.join(schedulerRoot, 'jobs.json'), { jobs: [] });
    fs.mkdirSync(path.join(schedulerRoot, 'logs'), { recursive: true });
    const now = new Date('2026-09-19T13:00:30.000Z');
    // A 10-minute tick, last ticked 8 minutes ago: fresher than one tick, but well past the
    // bare 5-minute floor that would have called it stale.
    writeJson(path.join(schedulerRoot, '.scheduler-heartbeat'), {
      lastTickAt: new Date(now.getTime() - 8 * 60_000).toISOString(), tickCount: 7, phaseMs: 1_004, tickMs: 600_000,
    });
    const report = await buildRuntimeHealthReport({
      agents: [], agentsRoot: path.join(root, 'agents'), schedulerRoot,
      agentMailDbPath: path.join(root, 'missing.db'), scheduledOutboxPath: path.join(root, 'outbox.jsonl'),
      now, includeOpenBrainSearch: false, includeOpenBrainMetadata: false,
      diskCheck: { status: 'ok', detail: 'pinned by fixture' },
    });
    expect(report.scheduler.checks.schedulerTickPhase.status).toBe('ok');
    expect(report.scheduler.checks.schedulerTickPhase.detail).toContain('1004ms');
  });

  // THE ALARM PATH, WHICH THE TEST ABOVE DOES NOT REACH. That one plants a HEALTHY phase
  // (1004ms) and proves only that the scaled window lets the check be evaluated at all.
  // A pass-shaped `unknown` and a genuine `ok` are both non-alarming, so nothing there
  // establishes that an over-threshold phase is ever actually reported.
  //
  // This plants an over-threshold phase in a heartbeat that is fresh ONLY under the scaled
  // window -- 8 minutes old against a 10-minute tick, which a bare 5-minute floor would
  // call stale. So the assertion is load-bearing in two directions at once:
  //   * revert `max(5 * 60_000, 5 * tickMs)` to a bare floor -> the heartbeat reads stale,
  //     the check degrades to `unknown`, and THE STATUS ASSERTION BELOW GOES RED.
  //   * lose the error branch -> status is not 'error' and it goes red too.
  //
  // The status is pinned EXACTLY rather than "not ok" on purpose. `unknown` is also not
  // ok, so a weaker assertion would stay green under the floor mutation while the check
  // silently stopped measuring anything -- testing that an alarm fires, not that it fires
  // for the right reason. (The `2baa9c1` lesson: assertion strength was inverse to case
  // importance, and the case that mattered had the weakest assertion.)
  it('reports an over-threshold tick phase as error when the heartbeat is fresh only under the scaled window', async () => {
    const root = tempDir();
    const schedulerRoot = path.join(root, 'scheduler');
    writeJson(path.join(schedulerRoot, 'job-types.json'), { validTypes: ['once', 'recurring'] });
    writeJson(path.join(schedulerRoot, 'jobs.json'), { jobs: [] });
    fs.mkdirSync(path.join(schedulerRoot, 'logs'), { recursive: true });
    const now = new Date('2026-09-19T13:00:30.000Z');
    writeJson(path.join(schedulerRoot, '.scheduler-heartbeat'), {
      lastTickAt: new Date(now.getTime() - 8 * 60_000).toISOString(),
      tickCount: 7,
      phaseMs: 45_000,
      tickMs: 600_000,
    });
    const report = await buildRuntimeHealthReport({
      agents: [], agentsRoot: path.join(root, 'agents'), schedulerRoot,
      agentMailDbPath: path.join(root, 'missing.db'), scheduledOutboxPath: path.join(root, 'outbox.jsonl'),
      now, includeOpenBrainSearch: false, includeOpenBrainMetadata: false,
      diskCheck: { status: 'ok', detail: 'pinned by fixture' },
    });
    expect(report.scheduler.checks.schedulerTickPhase.status).toBe('error');
    expect(report.scheduler.checks.schedulerTickPhase.detail).toContain('45000ms');
    expect(report.scheduler.checks.schedulerTickPhase.detail).not.toContain('stale heartbeat');
  });

  it('lets an injected disk result drive the summary, so the pin above is a real control', async () => {
    const root = tempDir();
    const schedulerRoot = path.join(root, 'scheduler');
    writeJson(path.join(schedulerRoot, 'job-types.json'), { validTypes: ['once', 'recurring'] });
    writeJson(path.join(schedulerRoot, 'jobs.json'), { jobs: [] });
    fs.mkdirSync(path.join(schedulerRoot, 'logs'), { recursive: true });
    const base = {
      agents: [],
      agentsRoot: path.join(root, 'agents'),
      schedulerRoot,
      agentMailDbPath: path.join(root, 'missing-agent-mail.db'),
      scheduledOutboxPath: path.join(root, 'outbox.jsonl'),
      now: new Date('2026-05-12T01:45:00.000Z'),
      includeOpenBrainSearch: false,
      includeOpenBrainMetadata: false,
    };

    const critical = await buildRuntimeHealthReport({ ...base, diskCheck: { status: 'error', detail: 'pinned critical' } });
    expect(critical.system.diskRoot.detail).toBe('pinned critical');
    expect(critical.summary.status).toBe('error');
  });

  it('passes Codex adapter checks when inbound bridge and outbound MCP are configured', async () => {
    const root = tempDir();
    const schedulerRoot = path.join(root, 'scheduler');
    const agentsRoot = path.join(root, 'agents');
    const agentRoot = path.join(agentsRoot, 'pilot');
    const contentRoot = path.join(root, 'content');
    const codexConfigPath = path.join(root, 'config.toml');
    writeJson(path.join(schedulerRoot, 'job-types.json'), { validTypes: ['once', 'recurring'] });
    writeJson(path.join(schedulerRoot, 'jobs.json'), { jobs: [] });
    fs.mkdirSync(path.join(schedulerRoot, 'logs'), { recursive: true });
    fs.mkdirSync(path.join(agentRoot, '.claude', 'discord'), { recursive: true });
    fs.mkdirSync(path.join(agentRoot, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(agentRoot, '.open-brain'), { recursive: true });
    fs.writeFileSync(path.join(agentRoot, 'launch.sh'), '#!/bin/zsh\n');
    fs.writeFileSync(path.join(agentRoot, '.runtime'), 'codex\n');
    fs.writeFileSync(path.join(agentRoot, '.claude', 'discord', '.env'), 'DISCORD_BOT_TOKEN=x\n');
    fs.writeFileSync(path.join(agentRoot, 'bin', 'discord-mcp-wrapper'), '#!/bin/zsh\n');
    fs.writeFileSync(codexConfigPath, '[mcp_servers.discord-pilot]\ncommand = "/tmp/pilot-wrapper"\n');
    writeJson(path.join(agentRoot, '.claude', 'discord', 'access.json'), {
      groups: {
        '1234567890': { requireMention: false },
      },
    });
    writeJson(path.join(contentRoot, 'bridge', 'discord.json'), {
      bindings: [{
        name: 'pilot',
        tokenEnvVar: 'DISCORD_BOT_TOKEN_ENZO',
        subscriptions: [{ agentKey: 'pilot', channelId: '1234567890' }],
      }],
    });

    const report = await buildRuntimeHealthReport({
      agents: ['pilot'],
      agentsRoot,
      schedulerRoot,
      agentMailDbPath: path.join(root, 'missing-agent-mail.db'),
      scheduledOutboxPath: path.join(root, 'outbox.jsonl'),
      codexConfigPath,
      contentRoot,
      now: new Date('2026-05-12T01:45:00.000Z'),
      includeOpenBrainSearch: false,
      includeOpenBrainMetadata: false,
    });

    expect(report.agents[0].codexInboundBridge.status).toBe('ok');
    expect(report.agents[0].codexOutboundDiscordMcp.status).toBe('ok');
    expect(report.agents[0].migrationReadiness.status).toBe('error');
  });

  it('accepts the shared Discord bridge for Codex when the optional direct MCP is absent', async () => {
    const root = tempDir();
    const schedulerRoot = path.join(root, 'scheduler');
    const agentsRoot = path.join(root, 'agents');
    const agentRoot = path.join(agentsRoot, 'pilot');
    const socketPath = path.join(root, 'agent-discord-bridge.sock');
    writeJson(path.join(schedulerRoot, 'job-types.json'), { validTypes: ['once', 'recurring'] });
    writeJson(path.join(schedulerRoot, 'jobs.json'), { jobs: [] });
    fs.mkdirSync(path.join(schedulerRoot, 'logs'), { recursive: true });
    fs.mkdirSync(path.join(agentRoot, '.claude', 'discord'), { recursive: true });
    fs.mkdirSync(path.join(agentRoot, '.open-brain'), { recursive: true });
    fs.writeFileSync(path.join(agentRoot, 'launch.sh'), '#!/bin/zsh\n');
    fs.writeFileSync(path.join(agentRoot, '.runtime'), 'codex\n');
    fs.writeFileSync(path.join(agentRoot, '.claude', 'discord', '.env'), 'DISCORD_BOT_TOKEN=x\n');
    fs.writeFileSync(path.join(agentRoot, '.open-brain', 'memory.env'), 'AGENT_MEMORY_KEY=x\n');
    writeJson(path.join(agentRoot, '.claude', 'discord', 'access.json'), {
      groups: { '1234567890': { requireMention: false } },
    });
    fs.writeFileSync(socketPath, 'bridge');
    process.env.DISCORD_BRIDGE_SOCKET_PATH = socketPath;

    const report = await buildRuntimeHealthReport({
      agents: ['pilot'],
      agentsRoot,
      schedulerRoot,
      agentMailDbPath: path.join(root, 'missing-agent-mail.db'),
      scheduledOutboxPath: path.join(root, 'outbox.jsonl'),
      codexConfigPath: path.join(root, 'missing-codex-config.toml'),
      contentRoot: path.join(root, 'content'),
      now: new Date('2026-05-12T01:45:00.000Z'),
      includeOpenBrainSearch: false,
      includeOpenBrainMetadata: false,
    });

    expect(report.agents[0].codexOutboundDiscordMcp.status).toBe('ok');
    expect(report.agents[0].discordOutboundMcp.status).toBe('ok');
    expect(report.agents[0].discordOutboundMcp.detail).toContain('shared bridge outbound available');
  });

  it('flags stale Discord inbox entries that have not crossed the delivery cursor', async () => {
    const root = tempDir();
    const schedulerRoot = path.join(root, 'scheduler');
    const agentsRoot = path.join(root, 'agents');
    const agentRoot = path.join(agentsRoot, 'pilot');
    const contentRoot = path.join(root, 'content');
    const codexConfigPath = path.join(root, 'config.toml');
    writeJson(path.join(schedulerRoot, 'job-types.json'), { validTypes: ['once', 'recurring'] });
    writeJson(path.join(schedulerRoot, 'jobs.json'), { jobs: [] });
    fs.mkdirSync(path.join(schedulerRoot, 'logs'), { recursive: true });
    fs.mkdirSync(path.join(agentRoot, '.claude', 'discord'), { recursive: true });
    fs.mkdirSync(path.join(agentRoot, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(contentRoot, 'bridge', 'inbox'), { recursive: true });
    fs.mkdirSync(path.join(contentRoot, 'bridge', 'runtime-state'), { recursive: true });
    fs.writeFileSync(path.join(agentRoot, 'launch.sh'), '#!/bin/zsh\n');
    fs.writeFileSync(path.join(agentRoot, '.runtime'), 'codex\n');
    fs.writeFileSync(path.join(agentRoot, '.claude', 'discord', '.env'), 'DISCORD_BOT_TOKEN=x\n');
    fs.writeFileSync(path.join(agentRoot, 'bin', 'discord-mcp-wrapper'), '#!/bin/zsh\n');
    fs.writeFileSync(codexConfigPath, '[mcp_servers.discord-pilot]\ncommand = "/tmp/pilot-wrapper"\n');
    writeJson(path.join(agentRoot, '.claude', 'discord', 'access.json'), {
      groups: {
        '1234567890': { requireMention: false },
      },
    });
    writeJson(path.join(contentRoot, 'bridge', 'discord.json'), {
      bindings: [{
        name: 'pilot',
        tokenEnvVar: 'DISCORD_BOT_TOKEN_ENZO',
        subscriptions: [{ agentKey: 'pilot', channelId: '1234567890' }],
      }],
    });
    fs.writeFileSync(path.join(contentRoot, 'bridge', 'runtime-state', 'pilot.json'), '{"lineCount":0}\n');
    fs.writeFileSync(path.join(contentRoot, 'bridge', 'inbox', 'pilot.jsonl'), `${JSON.stringify({
      id: 'discord_1',
      bindingName: 'pilot',
      agentKey: 'pilot',
      channelId: '1234567890',
      author: 'jeremy',
      content: 'are you listening',
      timestamp: '2026-05-12T01:30:00.000Z',
    })}\n`);

    const report = await buildRuntimeHealthReport({
      agents: ['pilot'],
      agentsRoot,
      schedulerRoot,
      agentMailDbPath: path.join(root, 'missing-agent-mail.db'),
      scheduledOutboxPath: path.join(root, 'outbox.jsonl'),
      codexConfigPath,
      contentRoot,
      now: new Date('2026-05-12T01:45:00.000Z'),
      includeOpenBrainSearch: false,
      includeOpenBrainMetadata: false,
    });

    expect(report.agents[0].discordInboxDelivery.status).toBe('error');
    expect(report.agents[0].discordInboxDelivery.detail).toContain('1 pending Discord inbox entries');
    expect(report.agents[0].migrationReadiness.detail).toContain('delivery=error');
    expect(formatRuntimeHealthSummary(report)).toContain('delivery=error');
  });

  it('treats OB1 MCP isError search responses as runtime-health errors', async () => {
    const root = tempDir();
    const schedulerRoot = path.join(root, 'scheduler');
    const agentsRoot = path.join(root, 'agents');
    const agentRoot = path.join(agentsRoot, 'pilot');
    const openBrainEnvPath = path.join(root, 'ob1.env');
    const accessKeyPath = path.join(root, 'mcp-access-key.txt');
    process.env.AGENTS_ROOT = agentsRoot;
    process.env.OPEN_BRAIN_ENV_PATH = openBrainEnvPath;
    process.env.OPEN_BRAIN_ACCESS_KEY_PATH = accessKeyPath;
    writeJson(path.join(schedulerRoot, 'job-types.json'), { validTypes: ['once', 'recurring'] });
    writeJson(path.join(schedulerRoot, 'jobs.json'), { jobs: [] });
    fs.mkdirSync(path.join(schedulerRoot, 'logs'), { recursive: true });
    fs.mkdirSync(path.join(agentRoot, '.open-brain'), { recursive: true });
    fs.writeFileSync(path.join(agentRoot, 'launch.sh'), '#!/bin/zsh\n');
    fs.writeFileSync(path.join(agentRoot, '.runtime'), 'codex\n');
    fs.writeFileSync(path.join(agentRoot, '.open-brain', 'memory.env'), 'AGENT_MEMORY_AGENT_ID=pilot\nAGENT_MEMORY_KEY=secret\n');
    fs.writeFileSync(openBrainEnvPath, 'SUPABASE_PROJECT_URL=https://example.test\nSUPABASE_SECRET_KEY=service\n');
    fs.writeFileSync(accessKeyPath, 'access');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      'event: message\ndata: {"result":{"content":[{"type":"text","text":"Agent \\"pilot\\" is not enabled"}],"isError":true}}\n\n',
      { status: 200 },
    )));

    const report = await buildRuntimeHealthReport({
      agents: ['pilot'],
      agentsRoot,
      schedulerRoot,
      agentMailDbPath: path.join(root, 'missing-agent-mail.db'),
      scheduledOutboxPath: path.join(root, 'outbox.jsonl'),
      now: new Date('2026-05-12T01:45:00.000Z'),
      includeOpenBrainMetadata: false,
    });

    expect(report.agents[0].lastOpenBrainSearch.status).toBe('error');
    expect(report.agents[0].lastOpenBrainSearch.detail).toContain('MCP error');
  });

  it('marks a fully configured Codex canary as migration-ready', async () => {
    const root = tempDir();
    const schedulerRoot = path.join(root, 'scheduler');
    const agentsRoot = path.join(root, 'agents');
    const agentRoot = path.join(agentsRoot, 'pilot');
    const contentRoot = path.join(root, 'content');
    const codexConfigPath = path.join(root, 'config.toml');
    const openBrainEnvPath = path.join(root, 'ob1.env');
    const accessKeyPath = path.join(root, 'mcp-access-key.txt');
    process.env.AGENTS_ROOT = agentsRoot;
    process.env.OPEN_BRAIN_ENV_PATH = openBrainEnvPath;
    process.env.OPEN_BRAIN_ACCESS_KEY_PATH = accessKeyPath;
    writeJson(path.join(schedulerRoot, 'job-types.json'), { validTypes: ['once', 'recurring'] });
    writeJson(path.join(schedulerRoot, 'jobs.json'), { jobs: [] });
    fs.mkdirSync(path.join(schedulerRoot, 'logs'), { recursive: true });
    fs.mkdirSync(path.join(agentRoot, '.claude', 'discord'), { recursive: true });
    fs.mkdirSync(path.join(agentRoot, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(agentRoot, '.open-brain'), { recursive: true });
    fs.mkdirSync(path.join(root, 'tmux', 'bridge', 'inbox'), { recursive: true });
    fs.mkdirSync(path.join(root, 'tmux', 'bridge', 'runtime-state'), { recursive: true });
    fs.mkdirSync(path.join(agentsRoot, 'SHARED', 'skills', 'runtime-canary'), { recursive: true });
    fs.writeFileSync(
      path.join(agentsRoot, 'SHARED', 'skills', 'runtime-canary', 'SKILL.md'),
      '---\nname: runtime-canary\ndescription: Runtime canary skill for agent isolation testing.\n---\nCanary.\n',
    );
    fs.writeFileSync(
      path.join(agentRoot, 'launch.sh'),
      '#!/bin/zsh\nnpm run runtime-launch --agent pilot --runtime "$LAUNCH_RUNTIME"\n',
    );
    fs.writeFileSync(path.join(agentRoot, '.runtime'), 'codex\n');
    fs.writeFileSync(path.join(agentRoot, '.claude', 'discord', '.env'), 'DISCORD_BOT_TOKEN=x\n');
    fs.writeFileSync(path.join(agentRoot, 'bin', 'discord-mcp-wrapper'), '#!/bin/zsh\n');
    fs.writeFileSync(path.join(agentRoot, '.open-brain', 'memory.env'), 'AGENT_MEMORY_AGENT_ID=pilot\nAGENT_MEMORY_KEY=secret\n');
    fs.writeFileSync(openBrainEnvPath, 'SUPABASE_PROJECT_URL=https://example.test\nSUPABASE_SECRET_KEY=service\n');
    fs.writeFileSync(accessKeyPath, 'access');
    fs.writeFileSync(codexConfigPath, '[mcp_servers.discord-pilot]\ncommand = "/tmp/pilot-wrapper"\n');
    writeJson(path.join(agentRoot, '.claude', 'discord', 'access.json'), {
      groups: {
        '1234567890': { requireMention: false },
      },
    });
    writeJson(path.join(contentRoot, 'bridge', 'discord.json'), {
      bindings: [{
        name: 'pilot',
        tokenEnvVar: 'DISCORD_BOT_TOKEN_ENZO',
        subscriptions: [{ agentKey: 'pilot', channelId: '1234567890' }],
      }],
    });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/rest/v1/thoughts')) {
        return new Response(JSON.stringify([
          {
            created_at: '2026-05-12T01:40:00.000Z',
            metadata: { owner_agent: 'pilot', scope: 'private_agent' },
          },
        ]), { status: 200 });
      }
      if (url.includes('/functions/v1/open-brain-mcp')) {
        return new Response('event: message\ndata: {"result":{"content":[{"type":"text","text":"ok"}]}}\n\n', { status: 200 });
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch);

    const report = await buildRuntimeHealthReport({
      agents: ['pilot'],
      agentsRoot,
      schedulerRoot,
      agentMailDbPath: path.join(root, 'agent-mail.db'),
      scheduledOutboxPath: path.join(root, 'outbox.jsonl'),
      codexConfigPath,
      contentRoot,
      now: new Date('2026-05-12T01:45:00.000Z'),
      includeOpenBrainSearch: true,
      includeOpenBrainMetadata: true,
    });

    expect(report.agents[0].migrationReadiness.status).toBe('ok');
  });

  it('warns when no pre-session context sidecar exists — agent started cold after compaction', async () => {
    // Regression: "The pattern that burns you" (CLAUDE.md) — agent restarts cold after
    // compaction (no SOUL.md found, no OB1 memory), health report must surface this
    // so the operator knows the agent is running without startup context.
    const root = tempDir();
    const schedulerRoot = path.join(root, 'scheduler');
    const agentsRoot = path.join(root, 'agents');
    const contentRoot = path.join(root, 'content');
    writeJson(path.join(schedulerRoot, 'job-types.json'), { validTypes: ['once', 'recurring'] });
    writeJson(path.join(schedulerRoot, 'jobs.json'), { jobs: [] });
    fs.mkdirSync(path.join(schedulerRoot, 'logs'), { recursive: true });
    fs.mkdirSync(path.join(agentsRoot, 'eli'), { recursive: true });
    fs.writeFileSync(path.join(agentsRoot, 'eli', 'launch.sh'), '#!/bin/zsh\nnpm run runtime-launch --agent eli --runtime "$LAUNCH_RUNTIME"\n');
    fs.writeFileSync(path.join(agentsRoot, 'eli', '.runtime'), 'claude\n');
    // No pre-session sidecar written — simulates cold start (no SOUL.md, no OB1 config)

    const report = await buildRuntimeHealthReport({
      agents: ['eli'],
      agentsRoot,
      schedulerRoot,
      agentMailDbPath: path.join(root, 'missing.db'),
      scheduledOutboxPath: path.join(root, 'outbox.jsonl'),
      contentRoot,
      now: new Date('2026-05-26T14:00:00.000Z'),
      includeOpenBrainSearch: false,
      includeOpenBrainMetadata: false,
    });

    expect(report.agents[0].preSessionContext.status).toBe('warn');
    expect(report.agents[0].preSessionContext.detail).toContain('cold');
    expect(formatRuntimeHealthSummary(report)).toContain('pre-session=warn');
  });

  it('reports ok when pre-session sidecar records soul and memory both present', async () => {
    const root = tempDir();
    const schedulerRoot = path.join(root, 'scheduler');
    const agentsRoot = path.join(root, 'agents');
    const contentRoot = path.join(root, 'content');
    const runtimeStateDir = path.join(contentRoot, 'bridge', 'runtime-state');
    writeJson(path.join(schedulerRoot, 'job-types.json'), { validTypes: ['once', 'recurring'] });
    writeJson(path.join(schedulerRoot, 'jobs.json'), { jobs: [] });
    fs.mkdirSync(path.join(schedulerRoot, 'logs'), { recursive: true });
    fs.mkdirSync(path.join(agentsRoot, 'eli'), { recursive: true });
    fs.mkdirSync(runtimeStateDir, { recursive: true });
    fs.writeFileSync(path.join(agentsRoot, 'eli', 'launch.sh'), '#!/bin/zsh\nnpm run runtime-launch --agent eli --runtime "$LAUNCH_RUNTIME"\n');
    fs.writeFileSync(path.join(agentsRoot, 'eli', '.runtime'), 'claude\n');
    writeJson(path.join(runtimeStateDir, 'eli-pre-session-context.json'), {
      hasSoul: true,
      hasMemory: true,
      runtime: 'claude',
      generatedAt: '2026-05-26T13:55:00.000Z',
    });

    const report = await buildRuntimeHealthReport({
      agents: ['eli'],
      agentsRoot,
      schedulerRoot,
      agentMailDbPath: path.join(root, 'missing.db'),
      scheduledOutboxPath: path.join(root, 'outbox.jsonl'),
      contentRoot,
      now: new Date('2026-05-26T14:00:00.000Z'),
      includeOpenBrainSearch: false,
      includeOpenBrainMetadata: false,
    });

    expect(report.agents[0].preSessionContext.status).toBe('ok');
    expect(report.agents[0].preSessionContext.detail).toContain('soul=true');
    expect(report.agents[0].preSessionContext.detail).toContain('memory=true');
  });

  it('warns when pre-session sidecar shows soul-only start (no OB1 memory)', async () => {
    const root = tempDir();
    const schedulerRoot = path.join(root, 'scheduler');
    const agentsRoot = path.join(root, 'agents');
    const contentRoot = path.join(root, 'content');
    const runtimeStateDir = path.join(contentRoot, 'bridge', 'runtime-state');
    writeJson(path.join(schedulerRoot, 'job-types.json'), { validTypes: ['once', 'recurring'] });
    writeJson(path.join(schedulerRoot, 'jobs.json'), { jobs: [] });
    fs.mkdirSync(path.join(schedulerRoot, 'logs'), { recursive: true });
    fs.mkdirSync(path.join(agentsRoot, 'eli'), { recursive: true });
    fs.mkdirSync(runtimeStateDir, { recursive: true });
    fs.writeFileSync(path.join(agentsRoot, 'eli', 'launch.sh'), '#!/bin/zsh\nnpm run runtime-launch --agent eli --runtime "$LAUNCH_RUNTIME"\n');
    fs.writeFileSync(path.join(agentsRoot, 'eli', '.runtime'), 'claude\n');
    writeJson(path.join(runtimeStateDir, 'eli-pre-session-context.json'), {
      hasSoul: true,
      hasMemory: false,
      runtime: 'claude',
      generatedAt: '2026-05-26T13:55:00.000Z',
    });

    const report = await buildRuntimeHealthReport({
      agents: ['eli'],
      agentsRoot,
      schedulerRoot,
      agentMailDbPath: path.join(root, 'missing.db'),
      scheduledOutboxPath: path.join(root, 'outbox.jsonl'),
      contentRoot,
      now: new Date('2026-05-26T14:00:00.000Z'),
      includeOpenBrainSearch: false,
      includeOpenBrainMetadata: false,
    });

    expect(report.agents[0].preSessionContext.status).toBe('warn');
    expect(report.agents[0].preSessionContext.detail).toContain('memory=false');
  });
});


describe('staleRecurring measures MISSED OCCURRENCES, not an estimated period (dc-20260923-004)', () => {
  // On 2026-09-23 this check flagged all 63 enabled recurring jobs, every day, and had done
  // since the June/July artifact cutover. Zero true negatives: a job that genuinely stopped
  // was formally indistinguishable from the 62 that hadn't, so the check could not detect
  // the one condition it exists for.
  //
  // The two controls below pull in OPPOSITE directions and neither is sufficient alone.
  // With no baseline discrimination to regress from, "the finding count went down" is
  // satisfiable by any change that makes the check quieter, including a wrong one. These
  // are the only two assertions that can distinguish a repair from a lobotomy.
  function scheduler(
    jobs: unknown[],
    artifacts: Array<{ name: string; ageMs: number }>,
    now: Date,
    // dc-20261009-004. `undefined` writes an EMPTY ledger, not NO ledger: an absent
    // `.fired-keys` is the `unknown` arm and every pre-existing test would silently move
    // into it, so the default has to be the readable-but-empty case. `null` writes a
    // deliberately unreadable ledger for the `unknown` test.
    firedKeys?: Array<{ key: string; firedAt: string }> | null,
  ) {
    const root = tempDir();
    const schedulerRoot = path.join(root, 'scheduler');
    const logsDir = path.join(schedulerRoot, 'logs');
    writeJson(path.join(schedulerRoot, 'job-types.json'), { validTypes: ['once', 'recurring'] });
    writeJson(path.join(schedulerRoot, 'jobs.json'), { jobs });
    if (firedKeys === null) {
      fs.mkdirSync(schedulerRoot, { recursive: true });
      fs.writeFileSync(path.join(schedulerRoot, '.fired-keys'), '{not json');
    } else {
      writeJson(path.join(schedulerRoot, '.fired-keys'), firedKeys ?? []);
    }
    fs.mkdirSync(logsDir, { recursive: true });
    for (const a of artifacts) {
      const f = path.join(logsDir, a.name);
      fs.writeFileSync(f, 'x');
      const t = new Date(now.getTime() - a.ageMs);
      fs.utimesSync(f, t, t);
    }
    return buildRuntimeHealthReport({
      agents: [], agentsRoot: path.join(root, 'agents'), schedulerRoot,
      agentMailDbPath: path.join(root, 'missing.db'), scheduledOutboxPath: path.join(root, 'out.jsonl'),
      now, includeOpenBrainSearch: false, includeOpenBrainMetadata: false,
      diskCheck: { status: 'ok', detail: 'pinned by fixture' },
    });
  }

  const NOW = new Date(2026, 8, 24, 18, 0); // 2026-09-24 18:00 local
  // `created` well before every occurrence these tests construct: the realistic shape, and
  // the one that keeps each test exercising its own property rather than the pre-creation
  // guard added 2026-09-27. Absent and pre-creation `created` have dedicated tests below.
  const CREATED = '2026-01-01T00:00:00Z';
  const daily = { id: 'daily-job', label: 'daily', agent: 'nova', type: 'recurring', cron: '0 9 * * *', created: CREATED };
  const annual = { id: 'annual-job', label: 'Annual met-day reminder', agent: 'isla', type: 'recurring', cron: '0 7 4 6 *', created: CREATED };

  it('CONTROL 1 — flags a job whose last completion predates a missed occurrence', () => {
    // Without this, the false positives get "fixed" by making the check blind, and that is
    // undetectable because the population simply goes quiet and quiet reads as healthy.
    return scheduler([daily], [{ name: 'daily-job-old.run-result.json', ageMs: 5 * 24 * 3600_000 }], NOW)
      .then((r) => {
        const ids = r.scheduler.staleRecurringJobs.map((j) => j.id);
        expect(ids).toContain('daily-job');
        expect(r.scheduler.checks.staleRecurring.status).toBe('warn');
      });
  });

  it('CONTROL 2 — does NOT flag a correct rare-cadence job with only legacy completion', () => {
    // 492a3b3c's real shape: an ANNUAL job that fired on 2026-06-04 and is not due again
    // until 2027, whose only artifact is a pre-cutover `.log`. It has completion evidence;
    // what it lacks is the current FORMAT. Any rule keyed on "a recent .run-result.json
    // exists" flags every annual and rare-cadence job forever, and that reads as the check
    // working because the population stays noisy.
    const juneFourth = new Date(2026, 5, 4, 7, 0);
    return scheduler([annual], [{ name: 'annual-job-2026-06-04T11-00-00.log', ageMs: NOW.getTime() - juneFourth.getTime() }], NOW)
      .then((r) => {
        expect(r.scheduler.staleRecurringJobs.map((j) => j.id)).not.toContain('annual-job');
        expect(r.scheduler.unevaluableScheduleJobs.map((j) => j.id)).not.toContain('annual-job');
      });
  });

  it('does not count PRE-SPAWN artifacts as completion', () => {
    // .prompt.txt and .system.txt are written BEFORE the child spawns, so treating them as
    // freshness reports a job healthy because it was ATTEMPTED -- a check passing because
    // its input arrived, which is this row's own defect class. (Eli's correction.)
    return scheduler([daily], [
      { name: 'daily-job-now.prompt.txt', ageMs: 60_000 },
      { name: 'daily-job-now.system.txt', ageMs: 60_000 },
    ], NOW).then((r) => {
      expect(r.scheduler.staleRecurringJobs.map((j) => j.id)).toContain('daily-job');
    });
  });

  // --- pre-creation guard (2026-09-27). A job cannot miss an occurrence that predates it.
  // Confirmed live across three agents: nova's a3f1c7e2 (created 09-17, cron `17 10 2 * *`,
  // flagged for 09-02), hank's f4ec9b7b and 6e818c2a (created 07-05, cron months 4 and 5).
  // Isla relayed two of these downstream as facts before anyone checked `created`.

  it('does NOT flag an occurrence that predates the job\'s own creation', () => {
    // nova's exact shape: monthly job created after the occurrence it was accused of missing.
    const born = { ...daily, id: 'born-late', cron: '0 9 2 * *', created: '2026-09-17T15:00:00Z' };
    return scheduler([born], [], NOW).then((r) => {
      expect(r.scheduler.staleRecurringJobs.map((j) => j.id)).not.toContain('born-late');
      // and it is NOT parked in unknown either -- the answer is known and it is "fine".
      expect(r.scheduler.unevaluableScheduleJobs.map((j) => j.id)).not.toContain('born-late');
    });
  });

  it('still flags a missed occurrence that comes AFTER creation', () => {
    // The paired positive. Without it, the guard above is satisfiable by never flagging.
    const born = { ...daily, id: 'born-early', cron: '0 9 2 * *', created: '2026-08-01T00:00:00Z' };
    return scheduler([born], [], NOW).then((r) => {
      expect(r.scheduler.staleRecurringJobs.map((j) => j.id)).toContain('born-early');
    });
  });

  it('absent `created` with completion evidence is still evaluated, not parked as unknown', () => {
    // 5 of the 6 live jobs missing `created` are long-period and genuinely flaggable,
    // including the newsletter assembly catch-up and the dated-commitment overdue check.
    // A completion artifact PROVES the job existed when it ran, so existence is established
    // by evidence rather than by a field. Blanket-unknown would blind those five.
    const { created, ...noCreated } = daily as Record<string, unknown>;
    return scheduler([{ ...noCreated, id: 'legacy-job' }], [
      { name: 'legacy-job-old.run-result.json', ageMs: 5 * 24 * 3600_000 },
    ], NOW).then((r) => {
      expect(r.scheduler.staleRecurringJobs.map((j) => j.id)).toContain('legacy-job');
      expect(r.scheduler.unevaluableScheduleJobs.map((j) => j.id)).not.toContain('legacy-job');
    });
  });

  it('absent `created` AND no completion evidence is unknown, never stale', () => {
    // Nothing available establishes existence at the occurrence, so the honest answer is
    // cannot-determine. `unknown` is never folded into ok or warn.
    const { created, ...noCreated } = daily as Record<string, unknown>;
    return scheduler([{ ...noCreated, id: 'orphan-job' }], [], NOW).then((r) => {
      expect(r.scheduler.staleRecurringJobs.map((j) => j.id)).not.toContain('orphan-job');
      expect(r.scheduler.unevaluableScheduleJobs.map((j) => j.id)).toContain('orphan-job');
      expect(r.scheduler.checks.scheduleEvaluable.status).toBe('unknown');
    });
  });

  it('unparseable `created` is unknown, never silently ignored', () => {
    return scheduler([{ ...daily, id: 'bad-created', created: 'not-a-date' }], [], NOW).then((r) => {
      expect(r.scheduler.unevaluableScheduleJobs.map((j) => j.id)).toContain('bad-created');
      expect(r.scheduler.staleRecurringJobs.map((j) => j.id)).not.toContain('bad-created');
    });
  });

  // ---- dc-20261009-004: staleOneShots tri-state -------------------------------------
  //
  // A one-shot still in jobs.json past its fireAt means one of FOUR different things and
  // the old check reported them identically, as `error: N one-shot job(s) are past fireAt`.
  // That sentence reads as IT DID NOT RUN. Measured on the live scheduler 2026-10-24: of 14
  // enabled once-jobs exactly one was stale, and it had FIRED with a completion artifact --
  // so the only live finding was a stale RECORD and the check sent a reader to re-run a job
  // that had already run. Opposite actions, one message.
  //
  // `.fired-keys` RECLASSIFIES, IT DOES NOT GATE. Suppressing a finding because the job
  // appears there would have hidden c7a7e039 (fired, timed out exit 143, failure
  // notification failed, record left behind) -- firing is not success, it only says WHICH
  // of the findings this is. That is the regression below.
  const ONCE_FIRE_AT = new Date(NOW.getTime() - 3 * 24 * 3600_000).toISOString();
  const ONCE_FIRED_AT = new Date(NOW.getTime() - 3 * 24 * 3600_000 + 1000).toISOString();
  const onceJob = (id: string) => ({ id, label: `checkpoint ${id}`, type: 'once', fireAt: ONCE_FIRE_AT });

  it('STATE never_fired: past fireAt with no firing record is an ERROR, the most severe', () => {
    // The job did not run. Work that was supposed to happen did not, and the action is to
    // run or re-date it. NOTE this state has ZERO live instances today, so this fixture is
    // the only instrument that can exercise the most severe arm -- a check validated only
    // against the current environment is a constant.
    return scheduler([onceJob('never-fired')], [], NOW, []).then((r) => {
      const e = r.scheduler.staleOneShotJobs.find((j) => j.id === 'never-fired');
      expect(e?.classification).toBe('never_fired');
      expect(r.scheduler.checks.staleOneShots.status).toBe('error');
      expect(r.scheduler.checks.staleOneShots.detail).toContain('NEVER FIRED');
    });
  });

  it('STATE fired_not_removed: fired with the run over is a WARN, and says the job RAN', () => {
    // The opposite action from never_fired: remove the record, do not re-run the job. The
    // detail has to say so, because "past fireAt by >5min" is what sent people the wrong way.
    return scheduler([onceJob('ran-ok')],
      [{ name: 'ran-ok-1.run-result.json', ageMs: 2 * 24 * 3600_000 }], NOW,
      [{ key: 'ran-ok:2026-8-21-18-0', firedAt: ONCE_FIRED_AT }]).then((r) => {
      const e = r.scheduler.staleOneShotJobs.find((j) => j.id === 'ran-ok');
      expect(e?.classification).toBe('fired_not_removed');
      expect(r.scheduler.checks.staleOneShots.status).toBe('warn');
      expect(r.scheduler.checks.staleOneShots.detail).toContain('FIRED but the record was not removed');
      expect(r.scheduler.checks.staleOneShots.detail).toContain('not to re-run it');
    });
  });

  it('STATE fired_run_in_progress: INSIDE its watchdog window is NOT a finding', () => {
    // Removal is scheduler-firing.ts:1218, AFTER persistRunResult at :1205 and inside the
    // awaited executeJob, so a once-job is still in jobs.json while running. Inside the
    // window that is correct behaviour and must stay silent.
    const firedJustNow = new Date(NOW.getTime() - 60_000).toISOString();
    return scheduler([onceJob('in-window')], [], NOW,
      [{ key: 'in-window:k', firedAt: firedJustNow }]).then((r) => {
      expect(r.scheduler.staleOneShotJobs.map((j) => j.id)).not.toContain('in-window');
      expect(r.scheduler.checks.staleOneShots.status).toBe('ok');
    });
  });

  it('the window is the JOB\'S OWN timeoutSeconds, not a fixed number', () => {
    // A long-running job (val's carries timeoutSeconds 2700) is legitimately still going ten
    // minutes in, where the 300s default would already have called it dead. The bound has to
    // come from the job or it is wrong for every job that sets one.
    const fired10mAgo = new Date(NOW.getTime() - 10 * 60_000).toISOString();
    return scheduler([{ ...onceJob('long-job'), timeoutSeconds: 2700 }], [], NOW,
      [{ key: 'long-job:k', firedAt: fired10mAgo }]).then((r) => {
      expect(r.scheduler.staleOneShotJobs.map((j) => j.id)).not.toContain('long-job');
    });
  });

  it('STATE fired_no_result: PAST the window with no result is an ERROR, not silence', () => {
    // ISLA'S MUST-CHANGE ON PR #37, AND MY OWN FIXTURE HAD PINNED THE HOLE AS CORRECT.
    // My first version returned in_progress for ANY elapsed time and the caller filtered
    // in_progress out, so a run that died without writing `.run-result.json` -- daemon crash,
    // restart, SIGKILL, none of which reach persistRunResult -- reported as in progress
    // FOREVER, i.e. SILENT. A true positive suppressed into `ok`: the c7a7e039 shape one step
    // earlier in the run, reintroduced by the fix for c7a7e039. This fixture previously
    // asserted `ok` for a job that fired 72h earlier against a 300s watchdog.
    //
    // It must NOT be fired_not_removed either: that message says "the job ran; do not re-run
    // it", which is actively wrong for a run that died -- the work may not have happened.
    return scheduler([onceJob('died-mid-run')], [], NOW,
      [{ key: 'died-mid-run:k', firedAt: ONCE_FIRED_AT }]).then((r) => {
      const e = r.scheduler.staleOneShotJobs.find((j) => j.id === 'died-mid-run');
      expect(e?.classification).toBe('fired_no_result');
      expect(r.scheduler.checks.staleOneShots.status).toBe('error');
      expect(r.scheduler.checks.staleOneShots.detail).toContain('NO completion record');
      expect(r.scheduler.checks.staleOneShots.detail).toContain('check whether the work happened');
      // and it must NOT carry the stale-record instruction
      expect(r.scheduler.checks.staleOneShots.detail).not.toContain('not to re-run it');
    });
  });

  it('a `.log` is NOT completion evidence -- it is written during the run', () => {
    // latestCompletionMtimeForJob accepts `<id>-*.log`, which would mark a RUNNING job
    // complete. One-shots read `.run-result.json` only. That helper is shared with
    // staleRecurring, where legacy .log files are deliberately still read, so it is narrowed
    // here rather than there.
    return scheduler([onceJob('log-only')],
      [{ name: 'log-only-1.log', ageMs: 2 * 24 * 3600_000 }], NOW,
      [{ key: 'log-only:k', firedAt: ONCE_FIRED_AT }]).then((r) => {
      const e = r.scheduler.staleOneShotJobs.find((j) => j.id === 'log-only');
      expect(e?.classification).toBe('fired_no_result');
    });
  });

  it('fired with NO firedAt is `unknown`, NOT the do-not-re-run arm', () => {
    // ISLA'S FOLLOW-UP NIT ON PR #37. This returned fired_not_removed, whose instruction is
    // "the job ran; do not re-run it" -- asserted with no evidence the run FINISHED. Being in
    // the fired set says it STARTED. Without a firedAt there is nothing to bound against and
    // no result confirming completion, so the honest answer is `unknown`.
    //
    // Third instance of one shape in this function: the died-run case and this one both fell
    // into the only arm that tells a human to STOP. Every fallthrough into fired_not_removed
    // is a claim, and absence must never be the thing that makes it.
    //
    // Unreachable against today's live ledger (35,001 entries, zero missing firedAt --
    // verified) and reachable the moment a firedAt arrives as a number or a null. A check
    // validated only against the current environment is a constant, which is why this is a
    // fixture rather than a note.
    return scheduler([onceJob('no-firedat')], [], NOW,
      [{ key: 'no-firedat:k' } as unknown as { key: string; firedAt: string }]).then((r) => {
      const e = r.scheduler.staleOneShotJobs.find((j) => j.id === 'no-firedat');
      expect(e?.classification).toBe('unknown');
      expect(r.scheduler.checks.staleOneShots.status).toBe('unknown');
      // and it must NOT carry the stale-record instruction
      expect(r.scheduler.checks.staleOneShots.detail).not.toContain('not to re-run it');
    });
  });

  it('EXHAUSTIVENESS: no arm matching renders unknown and NAMES the jobs, not a 0-count warn', () => {
    // THE FOUNDING DEFECT, and it is the reason this function exists. The chain this replaced
    // ended in a CATCH-ALL `check('warn', ...)`. The filter feeding the partition is a DENYLIST
    // (`!== 'fired_run_in_progress'`), so a classification nobody partitioned on passed through,
    // matched none of the four buckets, and fell to that arm. Output:
    //   "0 one-shot job(s) FIRED but the record was not removed ... : "
    // A zero count, an EMPTY job list, and an instruction to remove a record -- about a job that
    // may never have run. Red against the pre-change chain by construction: every bucket here is
    // empty, which is exactly the input that produced the 0-count warn.
    const job = {
      id: 'sixth-state', label: 'a state no arm handles', fireAt: ONCE_FIRED_AT,
      staleMinutes: 4320,
      classification: 'fired_but_reaped' as unknown as 'unknown',
    };
    const out = renderStaleOneShots({
      all: [job], neverFired: [], firedNoResult: [], firedNotRemoved: [], unclassified: [],
    });
    expect(out.status).toBe('unknown');                       // never 'warn'
    expect(out.detail).toContain('sixth-state');              // the job is NAMED
    expect(out.detail).toContain('does not handle');
    expect(out.detail).not.toContain('not to re-run it');     // never borrows the warn wording
    expect(out.detail).not.toMatch(/^0 /);                    // never a 0-count claim
  });

  it('EXHAUSTIVENESS: the warn arm is explicit, so it fires only on a non-empty bucket', () => {
    // The other half of removing a catch-all: the warn arm must still fire for its OWN state,
    // or the guard would have traded a false warn for a missing one.
    const job = {
      id: 'really-stale', label: 'fired, run over, record left', fireAt: ONCE_FIRED_AT,
      staleMinutes: 4320, classification: 'fired_not_removed' as const,
    };
    const out = renderStaleOneShots({
      all: [job], neverFired: [], firedNoResult: [], firedNotRemoved: [job], unclassified: [],
    });
    expect(out.status).toBe('warn');
    expect(out.detail).toContain('really-stale');
    expect(out.detail).toContain('not to re-run it');
  });

  it('STATE unknown: an unreadable firing ledger is `unknown`, never folded into ok', () => {
    // null is NOT an empty set. With an unreadable ledger every one-shot would classify as
    // never_fired -- the MOST SEVERE state -- so the distinction has to survive to the
    // caller. The checker is reporting its own limit, which is not a fault in the job.
    return scheduler([onceJob('cannot-tell')], [], NOW, null).then((r) => {
      const e = r.scheduler.staleOneShotJobs.find((j) => j.id === 'cannot-tell');
      expect(e?.classification).toBe('unknown');
      expect(r.scheduler.checks.staleOneShots.status).toBe('unknown');
      expect(r.scheduler.checks.staleOneShots.detail).toContain('could not be classified');
    });
  });

  it('REGRESSION c7a7e039: fired-then-timed-out is STILL a finding, not suppressed', () => {
    // THE FOUNDING CASE and the reason `.fired-keys` must reclassify rather than gate.
    // c7a7e039 fired, hit its watchdog (exit 143), its failure notification itself failed,
    // and its record was left in jobs.json. A gate that says "it is in .fired-keys, so not a
    // finding" suppresses exactly this. It must come back as a REAL finding naming the job.
    return scheduler([{ ...onceJob('c7a7e039'), label: 'timed out, notification failed' }],
      [{ name: 'c7a7e039-1.run-result.json', ageMs: 2 * 24 * 3600_000 }], NOW,
      [{ key: 'c7a7e039:2026-8-21-18-0', firedAt: ONCE_FIRED_AT }]).then((r) => {
      expect(r.scheduler.staleOneShotJobs.map((j) => j.id)).toContain('c7a7e039');
      expect(r.scheduler.checks.staleOneShots.status).not.toBe('ok');
      expect(r.scheduler.checks.staleOneShots.detail).toContain('c7a7e039');
    });
  });

  it('reports the MOST SEVERE state present, never an aggregate', () => {
    // One missed one-shot must not be averaged away by stale records sitting beside it. The
    // severities are ordered by what a human must DO, so the headline takes the worst and
    // the others are counted alongside it.
    return scheduler([onceJob('never-fired'), onceJob('ran-ok')],
      [{ name: 'ran-ok-1.run-result.json', ageMs: 2 * 24 * 3600_000 }], NOW,
      [{ key: 'ran-ok:2026-8-21-18-0', firedAt: ONCE_FIRED_AT }]).then((r) => {
      expect(r.scheduler.checks.staleOneShots.status).toBe('error');
      expect(r.scheduler.checks.staleOneShots.detail).toContain('NEVER FIRED');
      expect(r.scheduler.checks.staleOneShots.detail).toContain('plus 1 fired-but-not-removed');
    });
  });

  it('staleOneShots NAMES the jobs, because a bare count was unactionable', () => {
    // It read "3 one-shot job(s)" for weeks so nobody could clear them; and when isla
    // enumerated independently she got 4 (not filtering `enabled`) and concluded the count
    // was broken. An opaque correct answer invites someone to prove it wrong.
    const past = new Date(NOW.getTime() - 3 * 24 * 3600_000).toISOString();
    return scheduler([{ id: 'one-shot-a', label: 'checkpoint A', type: 'once', fireAt: past }], [], NOW)
      .then((r) => {
        expect(r.scheduler.checks.staleOneShots.status).toBe('error');
        expect(r.scheduler.checks.staleOneShots.detail).toContain('one-shot-a');
        expect(r.scheduler.checks.staleOneShots.detail).toContain('checkpoint A');
      });
  });

  it('accepts legacy .log as completion, and lets the newest evidence win', () => {
    return scheduler([daily], [
      { name: 'daily-job-stale.run-result.json', ageMs: 5 * 24 * 3600_000 },
      { name: 'daily-job-fresh.log', ageMs: 30 * 60_000 },
    ], NOW).then((r) => {
      expect(r.scheduler.staleRecurringJobs.map((j) => j.id)).not.toContain('daily-job');
    });
  });

  it('reports an unreadable schedule as UNKNOWN — not stale, and not ok', () => {
    // A checker that cannot read an expression is reporting its own limitation. Filing that
    // against the job is the wrong-subject defect that reported the anniversary of the day
    // Jeremy met Alison as a dead job; folding it into ok would be the false-clean instead.
    const broken = { id: 'broken-cron', label: 'bad', agent: 'nova', type: 'recurring', cron: '0 99 * * *' };
    return scheduler([broken], [], NOW).then((r) => {
      expect(r.scheduler.unevaluableScheduleJobs.map((j) => j.id)).toContain('broken-cron');
      expect(r.scheduler.staleRecurringJobs.map((j) => j.id)).not.toContain('broken-cron');
      expect(r.scheduler.checks.scheduleEvaluable.status).toBe('unknown');
    });
  });
});
