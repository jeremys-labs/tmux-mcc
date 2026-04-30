import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildAnswerContext, formatAnswerContext } from './answer-context.js';

describe('answer context', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'answer-context-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
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

    const context = await buildAnswerContext({
      agentKey: 'lena',
      source: 'discord',
      text: 'Daily weigh-in: 218.6',
      agentsRoot: tmpDir,
    });

    expect(context).toContain('<domain_state domain="fitness">');
    expect(context).toContain('Last completed: Lower');
    expect(context).toContain('Use this context before answering');
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
