import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  buildFastAnswerContext,
  classifyIntentLane,
  fastContextEnabled,
  recordDiscordTurnLatency,
} from './discord-fast-lane.js';

const lane = (text: string, extra: Partial<Parameters<typeof classifyIntentLane>[0]> = {}) =>
  classifyIntentLane({ text, ...extra }).lane;

describe('classifyIntentLane', () => {
  it('classifies status pings, banter, and acks as fast_chat', () => {
    for (const text of ['you up?', 'you there?', "how's it going", 'thanks', 'lol', 'nice', '👍', 'good morning']) {
      expect(lane(text), text).toBe('fast_chat');
    }
  });

  it('classifies self-contained opinions and general knowledge as fast_chat', () => {
    expect(lane('what do you think of monorepos?')).toBe('fast_chat');
    expect(lane('is this a dumb idea?')).toBe('fast_chat');
    expect(lane("what's the difference between TCP and UDP?")).toBe('fast_chat');
    expect(lane('why are my agents slower than ChatGPT?')).toBe('fast_chat');
  });

  it('classifies meta-follow-ups as fast_chat', () => {
    for (const text of ['shorter', 'explain that', 'why?', 'tl;dr']) {
      expect(lane(text), text).toBe('fast_chat');
    }
  });

  it('forces prior-context references to at least personal_context (Isla regression)', () => {
    expect(lane('did you finish that?')).toBe('personal_context');
    expect(lane('remember what we discussed last time?')).toBe('personal_context');
    expect(lane("what's the status of that thing")).toBe('personal_context');
    expect(lane('where did we land on the follow-up?')).toBe('personal_context');
  });

  it('routes named agents to coordination', () => {
    expect(lane('ask Isla about the plan')).toBe('coordination');
    expect(lane('did Eli push the fix?')).toBe('coordination');
  });

  it('routes family and person names to personal_context', () => {
    expect(lane('what should I get Alison for her birthday?')).toBe('personal_context');
    expect(lane('is Tom around next week?')).toBe('personal_context');
  });

  it('forces schedule, reminder, and job words out of fast', () => {
    for (const text of ['remind me to call at 7', 'schedule this for tomorrow', 'set up a cron for it', 'newsletter draft', 'run the job again']) {
      expect(lane(text), text).toBe('deep_work');
    }
  });

  it('forces money, health, legal, and credential prompts out of fast', () => {
    for (const text of [
      'what should I invest in?',
      'my shoulder symptom is back',
      'is this contract enforceable?',
      'where is the api key for tavily?',
    ]) {
      expect(lane(text), text).toBe('deep_work');
    }
  });

  it('routes current/latest/lookup prompts to current_lookup', () => {
    expect(lane("what's the latest on the Panthers?")).toBe('current_lookup');
    expect(lane('what is the price of NVDA stock')).toBe('current_lookup');
    expect(lane('best route to the airport right now')).toBe('current_lookup');
    expect(lane("what's the weather like")).toBe('current_lookup');
  });

  it('classifies work/build requests as deep_work', () => {
    expect(
      lane('please build the fast chat lane in the mcc-tmux repo, branch and commit for review'),
    ).toBe('deep_work');
    expect(lane('fix the bug in the deploy pipeline')).toBe('deep_work');
  });

  it('biases long messages to deep_work', () => {
    expect(lane(`hey ${'x'.repeat(650)}`)).toBe('deep_work');
  });

  it('forces attachments and reply-references out of fast', () => {
    expect(lane('nice', { hasAttachments: true })).toBe('deep_work');
    expect(lane('nice', { referencedMessageId: '123' })).toBe('personal_context');
  });

  it('defaults ambiguous prompts to deep_work (structural invariant)', () => {
    expect(lane('hmm let me think about the thing with the stuff')).toBe('deep_work');
    expect(lane('do the needful with the widget flow')).toBe('deep_work');
    expect(lane('xyzzy plugh')).toBe('deep_work');
  });

  it('returns reasons for auditability', () => {
    const decision = classifyIntentLane({ text: 'did you finish that?' });
    expect(decision.reasons.length).toBeGreaterThan(0);
  });
});

describe('fastContextEnabled', () => {
  it('is off by default and on only with the env flag', () => {
    expect(fastContextEnabled('eli', {})).toBe(false);
    expect(fastContextEnabled('eli', { DISCORD_FAST_CONTEXT_ENABLED: '1' })).toBe(true);
  });

  it('respects the per-agent allowlist for staged rollout', () => {
    const env = { DISCORD_FAST_CONTEXT_ENABLED: '1', DISCORD_FAST_CONTEXT_AGENTS: 'eli' };
    expect(fastContextEnabled('eli', env)).toBe(true);
    expect(fastContextEnabled('marcus', env)).toBe(false);
  });
});

describe('buildFastAnswerContext', () => {
  let agentsRoot: string;

  beforeEach(() => {
    agentsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fast-ctx-'));
    fs.mkdirSync(path.join(agentsRoot, 'eli'), { recursive: true });
    fs.writeFileSync(path.join(agentsRoot, 'eli', 'IDENTITY.md'), '# IDENTITY.md — Eli\n- Role: Staff Engineer\n');
  });

  afterEach(() => {
    fs.rmSync(agentsRoot, { recursive: true, force: true });
  });

  it('includes current datetime and the compact profile, and never governed memory', () => {
    const context = buildFastAnswerContext({ agentKey: 'eli', source: 'discord', agentsRoot, text: 'you up?' });
    expect(context).toContain('current_datetime');
    expect(context).toContain('runtime_profile');
    expect(context).toContain('Staff Engineer');
    expect(context).not.toContain('<governed_memory>');
    expect(context).not.toContain('scheduled_discord_outbox');
  });

  it('includes the escalation instruction', () => {
    const context = buildFastAnswerContext({ agentKey: 'eli', source: 'discord', agentsRoot, text: 'you up?' });
    expect(context).toMatch(/fast[- ]lane/i);
    expect(context).toMatch(/personal memory|full context|deeper/i);
  });

  it('omits the skill snapshot unless the prompt names a skill-like capability', () => {
    const plain = buildFastAnswerContext({ agentKey: 'eli', source: 'discord', agentsRoot, text: 'you up?' });
    expect(plain).not.toContain('<available_skills>');
  });
});

describe('recordDiscordTurnLatency', () => {
  it('appends a JSONL record with lane and duration, no message content', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'latency-'));
    const file = recordDiscordTurnLatency(
      {
        agentKey: 'eli',
        messageId: 'm1',
        chatId: 'c1',
        lane: 'fast_chat',
        fastPathUsed: true,
        answerContextMs: 12,
        contextBytes: 512,
      },
      dir,
    );
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]!);
    expect(record.lane).toBe('fast_chat');
    expect(record.answerContextMs).toBe(12);
    expect(record.messageId).toBe('m1');
    expect(record.ts).toBeTruthy();
    expect(JSON.stringify(record)).not.toContain('content');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
