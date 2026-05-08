import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildRuntimeHealthReport,
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
  for (const dir of tempRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('runtime health', () => {
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
    expect(summary).toContain('Scheduler:');
  });
});
