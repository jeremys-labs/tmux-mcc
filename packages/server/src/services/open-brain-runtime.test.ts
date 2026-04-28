import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  callOpenBrainTool,
  captureDiscordInboxEntry,
  formatStartupMemoryForCodex,
  resolveOpenBrainRuntimeConfig,
} from './open-brain-runtime.js';

describe('open brain runtime', () => {
  let tmpDir: string;
  let previousEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-brain-runtime-'));
    previousEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = previousEnv;
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('resolves config from local credential files', () => {
    const openBrainEnvPath = path.join(tmpDir, 'ob1.env');
    const accessKeyPath = path.join(tmpDir, 'mcp-key.txt');
    const agentEnvPath = path.join(tmpDir, 'memory.env');
    fs.writeFileSync(openBrainEnvPath, 'SUPABASE_PROJECT_URL=https://example.supabase.co\n');
    fs.writeFileSync(accessKeyPath, 'mcp-secret\n');
    fs.writeFileSync(agentEnvPath, 'AGENT_MEMORY_AGENT_ID=eli\nAGENT_MEMORY_KEY=agent-secret\n');
    process.env.OPEN_BRAIN_ENV_PATH = openBrainEnvPath;
    process.env.OPEN_BRAIN_ACCESS_KEY_PATH = accessKeyPath;
    process.env.AGENT_MEMORY_ENV_PATH = agentEnvPath;

    const config = resolveOpenBrainRuntimeConfig('eli');

    expect(config?.agentId).toBe('eli');
    expect(config?.endpointUrl).toContain('https://example.supabase.co/functions/v1/open-brain-mcp');
    expect(config?.endpointUrl).toContain('key=mcp-secret');
    expect(config?.endpointUrl).toContain('agent_key=agent-secret');
  });

  it('parses streamable MCP responses', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => 'event: message\ndata: {"result":{"content":[{"type":"text","text":"hello"}]},"jsonrpc":"2.0","id":1}\n\n',
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await callOpenBrainTool(
      { agentId: 'eli', endpointUrl: 'https://example.test/open-brain' },
      'search_agent_memory',
      { query: 'startup' },
    );

    expect(result.text).toBe('hello');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.test/open-brain',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Accept: 'application/json, text/event-stream' }),
      }),
    );
  });

  it('formats startup recall as injectable context', () => {
    const prompt = formatStartupMemoryForCodex('eli', 'Found memory');

    expect(prompt).toContain('[Open Brain Startup Recall]');
    expect(prompt).toContain('<memory_context source="open-brain" agent_id="eli">');
    expect(prompt).toContain('Found memory');
    expect(prompt).toContain('search Open Brain before answering');
  });

  it('captures discord entries as raw capture candidates', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => 'event: message\ndata: {"result":{"content":[{"type":"text","text":"captured"}]},"jsonrpc":"2.0","id":1}\n\n',
    });
    vi.stubGlobal('fetch', fetchMock);

    await captureDiscordInboxEntry(
      { agentId: 'eli', endpointUrl: 'https://example.test/open-brain' },
      {
        id: 'm1',
        agentKey: 'eli',
        channelId: 'c1',
        author: 'Jeremy',
        authorId: 'u1',
        content: 'Proceed',
        timestamp: '2026-04-28T03:26:28.262Z',
      },
    );

    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
    expect(body.params.name).toBe('capture_agent_memory');
    expect(body.params.arguments.scope).toBe('raw_capture');
    expect(body.params.arguments.authority).toBe('raw_capture');
    expect(body.params.arguments.source_ref).toBe('discord:m1');
    expect(body.params.arguments.content).toContain('Proceed');
  });
});
