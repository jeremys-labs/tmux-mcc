import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildRuntimeHealthReport,
  diskSpaceHealthFromKilobytes,
  formatRuntimeHealthSummary,
  loadSchedulerValidJobTypes,
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
    });

    expect(report.agents[0].codexInboundBridge.status).toBe('warn');
    expect(report.agents[0].codexInboundBridge.detail).toContain('pilot-discord-bridge');
    expect(report.agents[0].codexOutboundDiscordMcp.status).toBe('warn');
    expect(report.agents[0].codexOutboundDiscordMcp.detail).toContain('Codex config missing');
    expect(report.agents[0].migrationReadiness.status).toBe('error');
    expect(report.agents[0].migrationReadiness.detail).toContain('ob1-key');
    expect(report.summary.status).toBe('warn');
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
