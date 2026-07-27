import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  enumerateActiveAgents,
  evaluateProbeResponse,
  formatCanaryLine,
  probeAgent,
  runRecallCanary,
  type ProbeFetch,
  type ServiceResponse,
} from './recall-health-canary.js';

// The :4317 service returns a plain JSON tool result: {"text": "..."}.
const foundLine = (n: number, agent: string) =>
  JSON.stringify({ text: `Found ${n} ${agent}-readable memory item(s):\n\n--- Result 1 ---` });
const noneLine = (agent: string) =>
  JSON.stringify({ text: `No ${agent}-readable memories found matching "x".` });

describe('enumerateActiveAgents', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-agents-'));
    for (const a of ['eli', 'isla']) {
      fs.mkdirSync(path.join(root, a, '.open-brain'), { recursive: true });
      fs.writeFileSync(path.join(root, a, '.open-brain', 'memory.env'), 'AGENT_MEMORY_KEY=k');
      fs.writeFileSync(path.join(root, a, 'launch.sh'), '#!/bin/zsh');
    }
    // retired: has dir but no memory.env -> excluded
    fs.mkdirSync(path.join(root, 'harper'), { recursive: true });
    fs.writeFileSync(path.join(root, 'harper', 'launch.sh'), '#!/bin/zsh');
    // partial: memory.env but no launch.sh -> excluded
    fs.mkdirSync(path.join(root, 'half', '.open-brain'), { recursive: true });
    fs.writeFileSync(path.join(root, 'half', '.open-brain', 'memory.env'), 'AGENT_MEMORY_KEY=k');
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('includes only dirs with both memory.env and launch.sh (drops retired/partial)', () => {
    expect(enumerateActiveAgents(root)).toEqual(['eli', 'isla']);
  });
  it('returns [] for a missing root', () => {
    expect(enumerateActiveAgents('/nope/nope')).toEqual([]);
  });
});

describe('evaluateProbeResponse', () => {
  it('healthy: 200 + correctly-scoped Found N', () => {
    expect(evaluateProbeResponse('eli', 200, foundLine(3, 'eli'))).toMatchObject({ healthy: true });
  });
  it('healthy: Found 0 (sparse store is NOT an alert)', () => {
    expect(evaluateProbeResponse('eli', 200, foundLine(0, 'eli'))).toMatchObject({ healthy: true });
  });
  it('healthy: "No <agent>-readable memories found" (zero results, pipe works)', () => {
    expect(evaluateProbeResponse('eli', 200, noneLine('eli'))).toMatchObject({ healthy: true });
  });
  it('blind: HTTP non-200', () => {
    expect(evaluateProbeResponse('eli', 503, '')).toMatchObject({ healthy: false, reason: 'HTTP 503' });
  });
  it('blind: HTTP non-200 includes a bounded safe backend reason', () => {
    const body = JSON.stringify({
      error: 'memory_backend_failed',
      reason: 'agent_not_enabled',
      agent: 'dana',
    });
    expect(evaluateProbeResponse('dana', 502, body)).toMatchObject({
      healthy: false,
      reason: 'HTTP 502: agent not enabled',
    });
  });
  it('blind: ignores a backend reason scoped to a different agent', () => {
    const body = JSON.stringify({
      error: 'memory_backend_failed',
      reason: 'agent_not_enabled',
      agent: 'isla',
    });
    expect(evaluateProbeResponse('dana', 502, body)).toMatchObject({
      healthy: false,
      reason: 'HTTP 502',
    });
  });
  it('blind: unparseable body', () => {
    const r = evaluateProbeResponse('eli', 200, 'event: mes...not json');
    expect(r.healthy).toBe(false);
    expect(r.reason).toContain('unparseable');
  });
  it('blind: service {error} envelope', () => {
    expect(evaluateProbeResponse('eli', 200, JSON.stringify({ error: 'agent_memory_unconfigured' })).healthy).toBe(false);
  });
  it('blind: mis-scoped (another agent in the scope line)', () => {
    const r = evaluateProbeResponse('eli', 200, foundLine(2, 'isla'));
    expect(r.healthy).toBe(false);
    expect(r.reason).toContain('mis-scoped');
  });
  it('blind: unrecognized recall text shape', () => {
    const r = evaluateProbeResponse('eli', 200, JSON.stringify({ text: 'something unexpected' }));
    expect(r.healthy).toBe(false);
    expect(r.reason).toContain('unrecognized');
  });
});

describe('probeAgent retry behavior', () => {
  it('retries once on HTTP 5xx then succeeds', async () => {
    let n = 0;
    const fetchFn: ProbeFetch = async () => {
      n += 1;
      return n === 1 ? { status: 503, body: '' } : { status: 200, body: foundLine(1, 'eli') };
    };
    const r = await probeAgent('eli', fetchFn);
    expect(r.healthy).toBe(true);
    expect(n).toBe(2);
  });
  it('retries once on thrown (timeout) then succeeds', async () => {
    let n = 0;
    const fetchFn: ProbeFetch = async () => {
      n += 1;
      if (n === 1) throw new Error('timeout');
      return { status: 200, body: foundLine(1, 'eli') };
    };
    expect((await probeAgent('eli', fetchFn)).healthy).toBe(true);
  });
  it('does NOT retry a permanent verdict (404)', async () => {
    let n = 0;
    const fetchFn: ProbeFetch = async () => {
      n += 1;
      return { status: 404, body: '' } as ServiceResponse;
    };
    const r = await probeAgent('eli', fetchFn);
    expect(r.healthy).toBe(false);
    expect(n).toBe(1);
  });
});

describe('formatCanaryLine', () => {
  it('all healthy -> heartbeat', () => {
    expect(formatCanaryLine([{ agent: 'eli', healthy: true, reason: 'ok' }, { agent: 'isla', healthy: true, reason: 'ok' }]))
      .toBe('✅ recall verified 2/2 agents');
  });
  it('some blind -> names them + reason + healthy count', () => {
    const line = formatCanaryLine([
      { agent: 'eli', healthy: true, reason: 'ok' },
      { agent: 'isla', healthy: false, reason: 'HTTP 503' },
    ]);
    expect(line).toContain('Cannot read memory for isla');
    expect(line).toContain('isla (HTTP 503)');
    // The consequence must be stated, not just the probe result — this line
    // lands in Jeremy's DM and "recall BLIND" made him ask what it meant.
    expect(line).toContain('start cold');
    expect(line).toContain('Healthy 1/2');
  });
  it('reads correctly for one vs several blind agents', () => {
    const one = formatCanaryLine([{ agent: 'dana', healthy: false, reason: 'HTTP 502' }]);
    expect(one).toContain('Cannot read memory for dana — it will start cold');
    const two = formatCanaryLine([
      { agent: 'dana', healthy: false, reason: 'HTTP 502' },
      { agent: 'simone', healthy: false, reason: 'HTTP 502' },
    ]);
    expect(two).toContain('Cannot read memory for dana, simone — they will start cold');
    expect(two).toContain('Healthy 0/2');
  });
  it('zero agents -> explicit warning', () => {
    expect(formatCanaryLine([])).toContain('no active agents');
  });
});

describe('runRecallCanary (end to end with injected fetch)', () => {
  it('probes the provided agents and aggregates one line', async () => {
    const probeFetch: ProbeFetch = async (agent) =>
      agent === 'isla' ? { status: 500, body: '' } : { status: 200, body: foundLine(1, agent) };
    const { line, results } = await runRecallCanary({ agents: ['eli', 'isla', 'nova'], probeFetch });
    expect(results).toHaveLength(3);
    // isla 500 retried -> still 500 -> blind; eli/nova healthy
    expect(line).toContain('Healthy 2/3');
    expect(line).toContain('isla');
  });
});
