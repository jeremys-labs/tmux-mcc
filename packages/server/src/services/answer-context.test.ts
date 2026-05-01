import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildAnswerContext, formatAnswerContext } from './answer-context.js';

describe('answer context', () => {
  let tmpDir: string;
  const originalExtensionDisabled = process.env.OPEN_BRAIN_EXTENSION_CONTEXT_DISABLED;
  const originalProjectUrl = process.env.SUPABASE_PROJECT_URL;
  const originalSecretKey = process.env.SUPABASE_SECRET_KEY;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'answer-context-'));
    process.env.OPEN_BRAIN_EXTENSION_CONTEXT_DISABLED = '1';
    delete process.env.SUPABASE_PROJECT_URL;
    delete process.env.SUPABASE_SECRET_KEY;
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
  });

  it('formats governed memory and domain state as pre-answer context', () => {
    const prompt = formatAnswerContext({
      agentKey: 'remy',
      source: 'discord',
      memoryText: 'Shared team rule',
      domainContexts: [{ domain: 'food', content: 'Dinner is burgers.' }],
    });

    expect(prompt).toContain('[Answer Context] Retrieved before discord turn for remy.');
    expect(prompt).toContain('<governed_memory>');
    expect(prompt).toContain('Shared team rule');
    expect(prompt).toContain('<domain_state domain="food">');
    expect(prompt).toContain('Dinner is burgers.');
    expect(prompt).toContain('Do not ask Jeremy for information that is present here');
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
      text: async () => 'event: message\ndata: {"result":{"content":[{"type":"text","text":"OB1 says plain Discord messages only"}]},"jsonrpc":"2.0","id":1}\n\n',
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
  });
});
