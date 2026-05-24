import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildAnswerContext,
  compactOB1Results,
  formatAnswerContext,
  formatJeremyDateTime,
  isFreshSessionFirstTurnPayload,
  parseSearchAgentMemoryTrace,
  resolveJeremyTimezone,
} from './answer-context.js';

describe('answer context', () => {
  let tmpDir: string;
  const originalExtensionDisabled = process.env.OPEN_BRAIN_EXTENSION_CONTEXT_DISABLED;
  const originalProjectUrl = process.env.SUPABASE_PROJECT_URL;
  const originalSecretKey = process.env.SUPABASE_SECRET_KEY;
  const originalScheduledOutboxPath = process.env.SCHEDULED_DISCORD_OUTBOX_PATH;
  const originalSkillSnapshotDisabled = process.env.SKILL_SNAPSHOT_CONTEXT_DISABLED;
  const originalRecallTracePath = process.env.OPEN_BRAIN_RECALL_TRACE_PATH;
  const originalRecallTraceDisabled = process.env.OPEN_BRAIN_RECALL_TRACE_DISABLED;
  const originalJeremyTimezonePath = process.env.JEREMY_TIMEZONE_PATH;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'answer-context-'));
    process.env.OPEN_BRAIN_EXTENSION_CONTEXT_DISABLED = '1';
    process.env.SKILL_SNAPSHOT_CONTEXT_DISABLED = '1';
    delete process.env.SUPABASE_PROJECT_URL;
    delete process.env.SUPABASE_SECRET_KEY;
    process.env.SCHEDULED_DISCORD_OUTBOX_PATH = path.join(tmpDir, 'scheduled-discord-outbox.jsonl');
    process.env.OPEN_BRAIN_RECALL_TRACE_PATH = path.join(tmpDir, 'open-brain-recall-traces.jsonl');
    process.env.JEREMY_TIMEZONE_PATH = path.join(tmpDir, 'jeremy-timezone.json');
    delete process.env.OPEN_BRAIN_RECALL_TRACE_DISABLED;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (originalExtensionDisabled === undefined) {
      delete process.env.OPEN_BRAIN_EXTENSION_CONTEXT_DISABLED;
    } else {
      process.env.OPEN_BRAIN_EXTENSION_CONTEXT_DISABLED = originalExtensionDisabled;
    }
    if (originalProjectUrl === undefined) {
      delete process.env.SUPABASE_PROJECT_URL;
    } else {
      process.env.SUPABASE_PROJECT_URL = originalProjectUrl;
    }
    if (originalSecretKey === undefined) {
      delete process.env.SUPABASE_SECRET_KEY;
    } else {
      process.env.SUPABASE_SECRET_KEY = originalSecretKey;
    }
    if (originalScheduledOutboxPath === undefined) {
      delete process.env.SCHEDULED_DISCORD_OUTBOX_PATH;
    } else {
      process.env.SCHEDULED_DISCORD_OUTBOX_PATH = originalScheduledOutboxPath;
    }
    if (originalSkillSnapshotDisabled === undefined) {
      delete process.env.SKILL_SNAPSHOT_CONTEXT_DISABLED;
    } else {
      process.env.SKILL_SNAPSHOT_CONTEXT_DISABLED = originalSkillSnapshotDisabled;
    }
    if (originalRecallTracePath === undefined) {
      delete process.env.OPEN_BRAIN_RECALL_TRACE_PATH;
    } else {
      process.env.OPEN_BRAIN_RECALL_TRACE_PATH = originalRecallTracePath;
    }
    if (originalRecallTraceDisabled === undefined) {
      delete process.env.OPEN_BRAIN_RECALL_TRACE_DISABLED;
    } else {
      process.env.OPEN_BRAIN_RECALL_TRACE_DISABLED = originalRecallTraceDisabled;
    }
    if (originalJeremyTimezonePath === undefined) {
      delete process.env.JEREMY_TIMEZONE_PATH;
    } else {
      process.env.JEREMY_TIMEZONE_PATH = originalJeremyTimezonePath;
    }
  });

  it('formats governed memory and domain state as pre-answer context', () => {
    const prompt = formatAnswerContext({
      agentKey: 'remy',
      source: 'discord',
      now: new Date('2026-05-23T02:22:00.000Z'),
      memoryText: 'Shared team rule',
      domainContexts: [{ domain: 'food', content: 'Dinner is burgers.' }],
    });

    expect(prompt).toContain('[Answer Context] Retrieved before discord turn for remy.');
    expect(prompt).toContain("The current date/time in Jeremy's timezone is Friday 2026-05-22 10:22 PM ET.");
    expect(prompt).toContain('Timezone source: fallback: Home (Charlotte) — default.');
    expect(prompt).toContain('<governed_memory>');
    expect(prompt).toContain('Shared team rule');
    expect(prompt).toContain('<domain_state domain="food">');
    expect(prompt).toContain('Dinner is burgers.');
    expect(prompt).toContain('Do not ask Jeremy for information that is present here');
  });

  it('formats Jeremy timezone datetime in Eastern time', () => {
    expect(formatJeremyDateTime(new Date('2026-05-23T02:22:00.000Z'))).toBe('Friday 2026-05-22 10:22 PM ET');
  });

  it('uses active Jeremy travel timezone from the shared timezone file', async () => {
    fs.writeFileSync(process.env.JEREMY_TIMEZONE_PATH!, JSON.stringify({
      timezone: 'America/Chicago',
      label: 'Destin FL',
      reason: 'Family trip',
      valid_from: '2026-05-25',
      valid_until: '2026-05-30',
      source_ref: 'isla:travel-calendar-may-jun-2026',
    }));

    const now = new Date('2026-05-25T14:00:00.000Z');
    const timezone = resolveJeremyTimezone(now);
    expect(timezone).toMatchObject({
      timezone: 'America/Chicago',
      label: 'Destin FL',
      reason: 'Family trip',
      status: 'active',
    });
    expect(formatJeremyDateTime(now, timezone)).toBe('Monday 2026-05-25 9:00 AM CT');

    const context = await buildAnswerContext({
      agentKey: 'eli',
      source: 'discord',
      text: 'What time is it?',
      agentsRoot: tmpDir,
      now,
    });

    expect(context).toContain("The current date/time in Jeremy's timezone is Monday 2026-05-25 9:00 AM CT.");
    expect(context).toContain('Timezone source: Destin FL — Family trip (isla:travel-calendar-may-jun-2026).');
  });

  it('falls back to Eastern when Jeremy timezone file is expired', () => {
    fs.writeFileSync(process.env.JEREMY_TIMEZONE_PATH!, JSON.stringify({
      timezone: 'America/Chicago',
      label: 'Destin FL',
      reason: 'Family trip',
      valid_from: '2026-05-20',
      valid_until: '2026-05-21',
    }));

    const now = new Date('2026-05-23T14:00:00.000Z');
    const timezone = resolveJeremyTimezone(now);
    expect(timezone).toMatchObject({
      timezone: 'America/New_York',
      label: 'Home (Charlotte)',
      status: 'fallback',
    });
    expect(formatJeremyDateTime(now, timezone)).toBe('Saturday 2026-05-23 10:00 AM ET');
  });

  it('injects current Eastern datetime even without memory hits', async () => {
    const context = await buildAnswerContext({
      agentKey: 'eli',
      source: 'discord',
      text: 'Quick check',
      agentsRoot: tmpDir,
      now: new Date('2026-05-23T02:22:00.000Z'),
    });

    expect(context).toContain('[Answer Context] Retrieved before discord turn for eli.');
    expect(context).toContain("The current date/time in Jeremy's timezone is Friday 2026-05-22 10:22 PM ET.");
  });

  it('loads Remy meal state for food turns', async () => {
    const remyRoot = path.join(tmpDir, 'remy');
    fs.mkdirSync(path.join(remyRoot, 'ingredients'), { recursive: true });
    fs.writeFileSync(path.join(remyRoot, 'mealplan.md'), '# Plan\n\nWed Apr 29 | Vodka Bolognese');
    fs.writeFileSync(path.join(remyRoot, 'ingredients', '2026-04-29-vodka-bolognese.json'), JSON.stringify({
      date: '2026-04-29',
      meal: 'Vodka Bolognese',
    }));

    const context = await buildAnswerContext({
      agentKey: 'remy',
      source: 'discord',
      text: 'I had a light lunch',
      agentsRoot: tmpDir,
      now: new Date('2026-04-29T15:00:00-04:00'),
    });

    expect(context).toContain('<domain_state domain="food">');
    expect(context).toContain('Vodka Bolognese');
    expect(context).toContain("Today's recipe/ingredient state");
  });

  it('loads Lena fitness state for workout and weigh-in turns', async () => {
    const lenaRoot = path.join(tmpDir, 'lena');
    fs.mkdirSync(path.join(lenaRoot, 'memory', 'agents'), { recursive: true });
    fs.writeFileSync(
      path.join(lenaRoot, 'memory', 'agents', 'lena.md'),
      'Last completed: Lower (Mar 25). Pull attempted Apr 12 but not completed.',
    );
    fs.writeFileSync(
      path.join(lenaRoot, 'next-workout.json'),
      JSON.stringify({ nextWorkout: 'Pull', rotationIndex: 3 }),
    );

    const context = await buildAnswerContext({
      agentKey: 'lena',
      source: 'discord',
      text: 'Daily weigh-in: 218.6',
      agentsRoot: tmpDir,
    });

    expect(context).toContain('<domain_state domain="fitness">');
    expect(context).toContain('Lena current rotation state');
    expect(context).toContain('"nextWorkout":"Pull"');
    expect(context).toContain('Last completed: Lower');
    expect(context).toContain('Use this context before answering');
  });

  it('loads recent scheduled Discord outbox context for replies in the same chat', async () => {
    fs.writeFileSync(process.env.SCHEDULED_DISCORD_OUTBOX_PATH!, `${JSON.stringify({
      timestamp: '2026-05-05T11:30:00.000Z',
      job_id: 'weigh-in-job',
      label: 'Daily 7:30am weigh-in prompt',
      agent: 'lena',
      chat_ids: ['1492537718876672130'],
      prompt_excerpt: 'Send a Discord message to chat_id 1492537718876672130 asking Jeremy for his morning weigh-in.',
    })}\n${JSON.stringify({
      timestamp: '2026-05-05T11:30:00.000Z',
      job_id: 'other-chat-job',
      label: 'Other chat',
      agent: 'lena',
      chat_ids: ['111111111111111111'],
      prompt_excerpt: 'Do not include this.',
    })}\n`);

    const context = await buildAnswerContext({
      agentKey: 'lena',
      source: 'discord',
      text: '<channel source="discord" chat_id="1492537718876672130" message_id="m1">218.6</channel>',
      agentsRoot: tmpDir,
      now: new Date('2026-05-05T12:00:00.000Z'),
    });

    expect(context).toContain('<domain_state domain="scheduled_discord_outbox">');
    expect(context).toContain('Daily 7:30am weigh-in prompt');
    expect(context).toContain('asking Jeremy for his morning weigh-in');
    expect(context).not.toContain('Do not include this.');
  });

  it('adds current skill snapshot context when enabled', async () => {
    delete process.env.SKILL_SNAPSHOT_CONTEXT_DISABLED;
    const sharedSkillDir = path.join(tmpDir, 'SHARED', 'skills', 'runtime-canary');
    fs.mkdirSync(sharedSkillDir, { recursive: true });
    fs.writeFileSync(path.join(sharedSkillDir, 'SKILL.md'), [
      '---',
      'name: runtime-canary',
      'description: Report the runtime canary phrase.',
      '---',
      '',
      'When asked for the runtime canary phrase, reply exactly: central skills are live.',
    ].join('\n'));

    const context = await buildAnswerContext({
      agentKey: 'enzo',
      source: 'discord',
      text: 'Use the runtime canary skill.',
      agentsRoot: tmpDir,
    });

    expect(context).toContain('<domain_state domain="skills">');
    expect(context).toContain('skill_snapshot_version=');
    expect(context).toContain('<available_skills>');
    expect(context).toContain('runtime-canary');
    expect(context).toContain('Report the runtime canary phrase.');
  });

  it('prefers Remy meal-planning extension rows over local files', async () => {
    process.env.OPEN_BRAIN_EXTENSION_CONTEXT_DISABLED = '0';
    process.env.SUPABASE_PROJECT_URL = 'https://example.test';
    process.env.SUPABASE_SECRET_KEY = 'service-secret';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [{
          meal_date: '2026-04-30',
          meal_type: 'dinner',
          custom_meal: 'Burgers + Fries',
          status: 'locked',
          servings: 4,
          recipe_id: 'recipe-1',
          source_ref: 'remy-mealplan:2026-04-30:dinner',
        }],
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [{
          id: 'recipe-1',
          name: '5-star smash burgers',
          recipe_date: '2026-04-30',
          ingredients: [{ name: 'ground beef' }],
          source_ref: 'remy-ingredient:burgers.json',
        }],
      });
    vi.stubGlobal('fetch', fetchMock);

    const context = await buildAnswerContext({
      agentKey: 'remy',
      source: 'discord',
      text: 'What is dinner tonight?',
      agentsRoot: tmpDir,
      now: new Date('2026-04-30T18:00:00-04:00'),
    });

    expect(context).toContain('Meal-planning extension current rows');
    expect(context).toContain('Burgers + Fries');
    expect(context).toContain('status=locked');
  });

  it('prefers Lena fitness extension rows over local files', async () => {
    process.env.OPEN_BRAIN_EXTENSION_CONTEXT_DISABLED = '0';
    process.env.SUPABASE_PROJECT_URL = 'https://example.test';
    process.env.SUPABASE_SECRET_KEY = 'service-secret';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [{
          state_key: 'current_rotation',
          state: { nextWorkout: 'Pull', rotationIndex: 3 },
          source_ref: 'lena-next-workout-json:current',
        }],
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [{
          weigh_in_date: '2026-04-30',
          weight_lbs: 218,
        }],
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [{
          workout_date: '2026-04-09',
          workout_type: 'Cardio + McGill Big 3',
          status: 'completed',
          metrics: { value: 1.71 },
          source_ref: 'lena-agent-memory-metric:1',
        }],
      });
    vi.stubGlobal('fetch', fetchMock);

    const context = await buildAnswerContext({
      agentKey: 'lena',
      source: 'discord',
      text: 'What workout is next?',
      agentsRoot: tmpDir,
    });

    expect(context).toContain('Fitness extension current training state');
    expect(context).toContain('"nextWorkout":"Pull"');
    expect(context).toContain('Fitness extension recent weigh-ins');
    expect(context).toContain('weight_lbs=218');
  });

  it('searches OB1 before formatting answer context when configured', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => 'event: message\ndata: {"result":{"content":[{"type":"text","text":"Found 1 eli-readable memory item(s):\\n\\n--- Result 1 (87.5% match) ---\\nCaptured: 5/22/2026\\nScope: private_agent\\nOwner: eli\\nProject: agent:eli\\nAudience: eli\\nAuthority: context\\nConfidence: 0.7\\nType: agent_memory\\nSource: discord:123\\n\\nOB1 says plain Discord messages only"}]},"jsonrpc":"2.0","id":1}\n\n',
    });
    vi.stubGlobal('fetch', fetchMock);

    const context = await buildAnswerContext({
      agentKey: 'eli',
      source: 'discord',
      text: 'Should I reply in a thread?',
      openBrainConfig: {
        agentId: 'eli',
        endpointUrl: 'https://example.test/open-brain',
        agentMemoryKey: 'agent-secret',
      },
    });

    expect(context).toContain('OB1 says plain Discord messages only');
    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
    expect(body.params.name).toBe('search_agent_memory');
    expect(body.params.arguments.query).toContain('Should I reply in a thread?');
    const traces = fs.readFileSync(process.env.OPEN_BRAIN_RECALL_TRACE_PATH!, 'utf8')
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({
      agent: 'eli',
      source: 'discord',
      lookup: 'semantic',
      result_count: 1,
      empty: false,
    });
    expect(traces[0].results).toEqual([{
      rank: 1,
      similarity: 0.875,
      source_ref: 'discord:123',
      scope: 'private_agent',
      project: 'agent:eli',
      authority: 'context',
    }]);
  });

  it('adds recent activity fallback search on fresh session first turn', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        text: async () => 'event: message\ndata: {"result":{"content":[{"type":"text","text":"Semantic restart result"}]},"jsonrpc":"2.0","id":1}\n\n',
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => 'event: message\ndata: {"result":{"content":[{"type":"text","text":"Recent Discord MCP outage work"}]},"jsonrpc":"2.0","id":2}\n\n',
      });
    vi.stubGlobal('fetch', fetchMock);

    const context = await buildAnswerContext({
      agentKey: 'isla',
      source: 'discord',
      text: 'Okay, restarted. Discord working?',
      freshSessionFirstTurn: true,
      openBrainConfig: {
        agentId: 'isla',
        endpointUrl: 'https://example.test/open-brain',
        agentMemoryKey: 'agent-secret',
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(context).toContain('Semantic restart result');
    expect(context).toContain('Recent activity fallback for fresh session first turn');
    expect(context).toContain('Recent Discord MCP outage work');
    const recentBody = JSON.parse(fetchMock.mock.calls[1]?.[1]?.body as string);
    expect(recentBody.params.arguments.query).toBe('recent isla session activity work troubleshooting restart current task');
    expect(recentBody.params.arguments.limit).toBe(3);
    const traces = fs.readFileSync(process.env.OPEN_BRAIN_RECALL_TRACE_PATH!, 'utf8')
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(traces.map((trace) => trace.lookup).sort()).toEqual(['recent', 'semantic']);
  });

  it('parses governed search results for recall trace metadata', () => {
    expect(parseSearchAgentMemoryTrace([
      'Found 1 eli-readable memory item(s):',
      '',
      '--- Result 1 (42.6% match) ---',
      'Captured: 5/22/2026',
      'Scope: project',
      'Owner: isla',
      'Project: agent-mail',
      'Audience: isla, eli',
      'Authority: source_of_truth',
      'Confidence: 0.85',
      'Type: reference',
      'Source: agent-mail:msg_123',
      '',
      'Memory body',
    ].join('\n'))).toEqual([{
      rank: 1,
      similarity: 0.426,
      source_ref: 'agent-mail:msg_123',
      scope: 'project',
      project: 'agent-mail',
      authority: 'source_of_truth',
    }]);
  });

  it('ignores nested historical result blocks in governed memory content', () => {
    const trace = parseSearchAgentMemoryTrace([
      'Found 2 eli-readable memory item(s):',
      '',
      '--- Result 1 (80.0% match) ---',
      'Scope: private_agent',
      'Project: agent:eli',
      'Authority: context',
      'Source: real:1',
      '',
      'Old pasted result:',
      '--- Result 1 (99.0% match) ---',
      'Scope: private_agent',
      'Project: stale',
      'Authority: context',
      'Source: nested:stale',
      '',
      '--- Result 2 (70.0% match) ---',
      'Scope: project',
      'Project: ob1-memory',
      'Authority: context',
      'Source: real:2',
    ].join('\n'));

    expect(trace.map((item) => item.source_ref)).toEqual(['real:1', 'real:2']);
  });

  it('passes non-OB1-format text through compactOB1Results unchanged', () => {
    expect(compactOB1Results('Semantic restart result', 'restart', 0.45)).toBe('Semantic restart result');
    expect(compactOB1Results('', 'anything', 0.45)).toBe('');
  });

  it('filters private_agent result when prompt does not name the project and similarity is below high threshold', () => {
    const text = [
      'Found 1 eli-readable memory item(s):',
      '',
      '--- Result 1 (60.0% match) ---',
      'Scope: private_agent',
      'Owner: eli',
      'Project: gradesnap',
      'Authority: context',
      'Source: gradesnap:doc1',
      '',
      'GradeSnap implementation notes.',
    ].join('\n');
    expect(compactOB1Results(text, 'Should I reply in a thread?', 0.45)).toBe('');
  });

  it('admits private_agent result when prompt names the project', () => {
    const text = [
      'Found 1 eli-readable memory item(s):',
      '',
      '--- Result 1 (60.0% match) ---',
      'Scope: private_agent',
      'Owner: eli',
      'Project: gradesnap',
      'Authority: context',
      'Source: gradesnap:doc1',
      '',
      'GradeSnap implementation notes.',
    ].join('\n');
    const result = compactOB1Results(text, 'What is the status of gradesnap?', 0.45);
    expect(result).toContain('GradeSnap implementation notes.');
  });

  it('always admits source_of_truth authority regardless of scope or similarity', () => {
    const text = [
      'Found 1 eli-readable memory item(s):',
      '',
      '--- Result 1 (50.0% match) ---',
      'Scope: private_agent',
      'Project: secret-project',
      'Authority: source_of_truth',
      'Source: ref:1',
      '',
      'Always-included fact.',
    ].join('\n');
    const result = compactOB1Results(text, 'Unrelated question', 0.45);
    expect(result).toContain('Always-included fact.');
  });

  it('admits private_agent result with high similarity even without prompt context mention', () => {
    const text = [
      'Found 1 eli-readable memory item(s):',
      '',
      '--- Result 1 (80.0% match) ---',
      'Scope: private_agent',
      'Project: some-private-project',
      'Authority: context',
      'Source: ref:2',
      '',
      'High-similarity private fact.',
    ].join('\n');
    const result = compactOB1Results(text, 'Totally unrelated question', 0.45);
    expect(result).toContain('High-similarity private fact.');
  });

  it('compacts body to 300 chars for medium-similarity non-source-of-truth results', () => {
    const longBody = 'A'.repeat(600);
    const text = [
      'Found 1 eli-readable memory item(s):',
      '',
      '--- Result 1 (74.0% match) ---',
      'Scope: shared_team',
      'Authority: context',
      'Source: ref:3',
      '',
      longBody,
    ].join('\n');
    const result = compactOB1Results(text, 'Anything', 0.45);
    expect(result).toContain('...');
    const bodyInResult = result.split('\n\n').slice(1).join('\n\n');
    expect(bodyInResult.length).toBeLessThan(400);
  });

  it('admits shared_team result at base threshold without project mention requirement', () => {
    const text = [
      'Found 1 eli-readable memory item(s):',
      '',
      '--- Result 1 (50.0% match) ---',
      'Scope: shared_team',
      'Authority: context',
      'Source: ref:4',
      '',
      'Team-wide rule.',
    ].join('\n');
    expect(compactOB1Results(text, 'Any unrelated question', 0.45)).toContain('Team-wide rule.');
  });

  it('detects first-turn payloads without prior assistant turns', () => {
    expect(isFreshSessionFirstTurnPayload({
      messages: [{ role: 'user', content: 'restart check' }],
    })).toBe(true);
    expect(isFreshSessionFirstTurnPayload({
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
      ],
    })).toBe(false);
    expect(isFreshSessionFirstTurnPayload({ parentUuid: null })).toBe(true);
    expect(isFreshSessionFirstTurnPayload({ parentUuid: 'previous-turn' })).toBe(false);
  });
});
