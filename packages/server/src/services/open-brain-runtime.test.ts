import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  callOpenBrainTool,
  captureAgentMailMessage,
  captureClaudeHookEvent,
  captureClaudePromptEvent,
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

  it('resolves service-only config without exposing per-agent credentials to the client', () => {
    process.env.OPEN_BRAIN_ENV_PATH = path.join(tmpDir, 'missing-ob1.env');
    process.env.AGENT_MEMORY_ENV_PATH = path.join(tmpDir, 'missing-memory.env');
    process.env.AGENT_MEMORY_SERVICE_URL = 'http://127.0.0.1:4317';
    process.env.AGENT_MEMORY_SERVICE_TOKEN = 'service-secret';

    expect(resolveOpenBrainRuntimeConfig('nova')).toEqual({
      agentId: 'nova',
      agentKey: 'nova',
      endpointUrl: '',
      agentMemoryKey: '',
      serviceUrl: 'http://127.0.0.1:4317',
      serviceToken: 'service-secret',
      serviceMode: 'service',
    });
  });

  it('routes runtime memory calls through the independent service in service mode', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => '{"text":"service recall"}',
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await callOpenBrainTool(
      {
        agentId: 'nova',
        endpointUrl: '',
        agentMemoryKey: '',
        serviceUrl: 'http://127.0.0.1:4317',
        serviceToken: 'service-secret',
        serviceMode: 'service',
      },
      'search_agent_memory',
      { query: 'current work' },
    );

    expect(result.text).toBe('service recall');
    expect(fetchMock.mock.calls[0][0].toString()).toBe('http://127.0.0.1:4317/v1/tool');
  });

  it('routes non-runtime tools to the direct endpoint when service mode is enabled', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => 'data: {"result":{"content":[{"type":"text","text":"classified"}]}}\n',
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await callOpenBrainTool(
      {
        agentId: 'nova',
        agentKey: 'nova',
        endpointUrl: 'https://example.test/open-brain',
        agentMemoryKey: 'agent-secret',
        serviceUrl: 'http://127.0.0.1:4317',
        serviceMode: 'service',
      },
      'classify_agent_raw_capture',
      { content: 'candidate' },
    );

    expect(result.text).toBe('classified');
    expect(fetchMock.mock.calls[0][0]).toBe('https://example.test/open-brain');
  });

  it('fails clearly when a non-runtime tool has only a service endpoint', async () => {
    await expect(callOpenBrainTool(
      {
        agentId: 'nova',
        agentKey: 'nova',
        endpointUrl: '',
        agentMemoryKey: '',
        serviceUrl: 'http://127.0.0.1:4317',
        serviceMode: 'service',
      },
      'classify_agent_raw_capture',
      { content: 'candidate' },
    )).rejects.toThrow('unavailable through the agent-memory service');
  });

  it('records content-free parity evidence for shadow retrievals', async () => {
    const tracePath = path.join(tmpDir, 'shadow.jsonl');
    process.env.AGENT_MEMORY_SHADOW_TRACE_PATH = tracePath;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        text: async () => 'data: {"result":{"content":[{"type":"text","text":"same recall"}]}}\n',
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => '{"text":"same recall"}',
      });
    vi.stubGlobal('fetch', fetchMock);

    await callOpenBrainTool(
      {
        agentId: 'nova',
        agentKey: 'nova',
        endpointUrl: 'https://example.test/open-brain',
        agentMemoryKey: 'agent-secret',
        serviceUrl: 'http://127.0.0.1:4317',
        serviceMode: 'shadow',
      },
      'search_agent_memory',
      { query: 'current work' },
    );
    await vi.waitFor(() => expect(fs.existsSync(tracePath)).toBe(true));

    const trace = JSON.parse(fs.readFileSync(tracePath, 'utf8').trim());
    expect(trace).toMatchObject({
      agent: 'nova',
      operation: 'search_agent_memory',
      status: 'match',
      embedded_bytes: 11,
      service_bytes: 11,
    });
    expect(JSON.stringify(trace)).not.toContain('same recall');
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

  it('throws when streamable MCP responses return isError', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => 'event: message\ndata: {"result":{"content":[{"type":"text","text":"Agent \\"jordan\\" is not enabled"}],"isError":true},"jsonrpc":"2.0","id":1}\n\n',
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(callOpenBrainTool(
      { agentId: 'jordan', endpointUrl: 'https://example.test/open-brain' },
      'capture_agent_memory',
      { agent_id: 'jordan' },
    )).rejects.toThrow('Agent "jordan" is not enabled');
  });

  it('retries transient search failures and then succeeds', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce({
        ok: true,
        text: async () => 'data: {"result":{"content":[{"type":"text","text":"recalled"}]},"jsonrpc":"2.0","id":1}\n\n',
      });
    vi.stubGlobal('fetch', fetchMock);

    const result = await callOpenBrainTool(
      { agentId: 'nova', endpointUrl: 'https://example.test/open-brain', agentMemoryKey: 'agent-secret' },
      'search_agent_memory',
      { query: 'startup' },
      { maxAttempts: 2, retryDelayMs: 0 },
    );

    expect(result.text).toBe('recalled');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry permanent authentication failures', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => '{"error":"Invalid or missing access key"}',
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(callOpenBrainTool(
      { agentId: 'nova', endpointUrl: 'https://example.test/open-brain', agentMemoryKey: 'agent-secret' },
      'search_agent_memory',
      { query: 'startup' },
      { maxAttempts: 2, retryDelayMs: 0 },
    )).rejects.toThrow('401');
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
    expect(body.params.arguments.content).toBe('Proceed');
    expect(body.params.arguments.content).not.toContain('Raw capture candidate');
    expect(body.params.arguments.content).not.toContain('This is a candidate');
  });

  it('redacts structured and free-text credentials from Discord inbox raw captures', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => 'event: message\ndata: {"result":{"content":[{"type":"text","text":"captured"}]},"jsonrpc":"2.0","id":1}\n\n',
    });
    vi.stubGlobal('fetch', fetchMock);
    const sha = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const uuid = '123e4567-e89b-12d3-a456-426614174000';
    const chatId = '1491979880747765810';
    const url = 'https://example.test/path?mode=safe';

    await captureDiscordInboxEntry(
      { agentId: 'eli', endpointUrl: 'https://example.test/open-brain' },
      {
        id: 'discord-redaction',
        agentKey: 'eli',
        channelId: 'c1',
        author: 'Jeremy',
        authorId: 'u1',
        content: `{"api_key":"discord-structured-canary"} Authorization: Bearer DISCORDFREETEXTCANARY123 ${sha} ${uuid} ${chatId} ${url} ordinary prose`,
        timestamp: '2026-11-12T12:00:00.000Z',
      },
    );

    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
    const content = body.params.arguments.content as string;
    expect(content).not.toContain('discord-structured-canary');
    expect(content).not.toContain('DISCORDFREETEXTCANARY123');
    expect(content.match(/\[REDACTED\]/g)).toHaveLength(2);
    expect(content).toContain(sha);
    expect(content).toContain(uuid);
    expect(content).toContain(chatId);
    expect(content).toContain(url);
    expect(content).toContain('ordinary prose');
  });

  it('redacts structured and free-text credentials from agent-mail raw captures', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => 'event: message\ndata: {"result":{"content":[{"type":"text","text":"captured"}]},"jsonrpc":"2.0","id":1}\n\n',
    });
    vi.stubGlobal('fetch', fetchMock);
    const sha = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const uuid = '123e4567-e89b-12d3-a456-426614174000';
    const chatId = '1491979880747765810';
    const url = 'https://example.test/path?mode=safe';

    await captureAgentMailMessage(
      { agentId: 'eli', endpointUrl: 'https://example.test/open-brain' },
      {
        id: 'msg_redaction',
        correlationId: 'corr_redaction',
        fromAgent: 'marcus',
        toAgent: 'eli',
        type: 'artifact',
        priority: 'normal',
        subject: '{"client_secret":"mail-structured-canary"}',
        bodyMd: `Authorization: Bearer MAILFREETEXTCANARY12345 ${sha} ${uuid} ${chatId} ${url} ordinary prose`,
        relatedProject: null,
        requiresResponse: false,
        status: 'new',
        createdAt: '2026-11-12T12:00:00.000Z',
        ackedAt: null,
        closedAt: null,
      },
    );

    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
    const content = body.params.arguments.content as string;
    expect(body.params.arguments.source_ref).toBe('agent-mail:msg_redaction');
    expect(content).not.toContain('mail-structured-canary');
    expect(content).not.toContain('MAILFREETEXTCANARY12345');
    expect(content.match(/\[REDACTED\]/g)).toHaveLength(2);
    expect(content).toContain(sha);
    expect(content).toContain(uuid);
    expect(content).toContain(chatId);
    expect(content).toContain(url);
    expect(content).toContain('ordinary prose');
  });

  it('captures bounded Claude hook evidence for grooming and validation', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => 'event: message\ndata: {"result":{"content":[{"type":"text","text":"captured"}]},"jsonrpc":"2.0","id":1}\n\n',
    });
    vi.stubGlobal('fetch', fetchMock);

    await captureClaudeHookEvent(
      { agentId: 'isla', endpointUrl: 'https://example.test/open-brain', agentMemoryKey: 'agent-secret' },
      'PostToolUse',
      {
        cwd: '/Volumes/Repo-Drive/agents/isla',
        session_id: 's1',
        tool_name: 'Write',
        tool_input: {
          file_path: '/Volumes/Repo-Drive/agents/isla/memory/MEMORY.md',
          content: '<channel source="plugin:discord:discord" chat_id="c1">ob1-validation-retry3-12345 durable memory write context</channel>',
        },
      },
    );

    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
    expect(body.params.arguments.agent_id).toBe('isla');
    expect(body.params.arguments.source_ref).toBe('claude-hook:PostToolUse:s1');
    expect(body.params.arguments.content).toContain('File: /Volumes/Repo-Drive/agents/isla/memory/MEMORY.md');
    expect(body.params.arguments.content).toContain('File content excerpt: ob1-validation-retry3-12345');
    expect(body.params.arguments.content).not.toContain('<channel source=');
    expect(body.params.arguments.content).not.toContain('Raw capture candidate');
    expect(body.params.arguments.content).not.toContain('Working directory:');
    expect(body.params.arguments.content).not.toContain('This is a candidate');
  });

  it('redacts request-side structured and free-text credentials before compaction and truncation', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => 'event: message\ndata: {"result":{"content":[{"type":"text","text":"captured"}]},"jsonrpc":"2.0","id":1}\n\n',
    });
    vi.stubGlobal('fetch', fetchMock);
    const capSplitCanary = `sk-cap-${'A'.repeat(40)}`;

    await captureClaudeHookEvent(
      { agentId: 'eli', endpointUrl: 'https://example.test/open-brain', agentMemoryKey: 'agent-secret' },
      'PostToolUse',
      {
        session_id: 'request-redaction',
        tool_name: 'Write',
        tool_input: {
          content: `${'x'.repeat(1185)} ${capSplitCanary}`,
          message: 'SUPABASE_SECRET_KEY=service-key-canary',
          edits: [{ api_key: 'structured-request-canary', note: 'ordinary prose' }],
        },
        invocation: {
          server: 'example',
          tool: 'write',
          arguments: {
            text: {
              authorization: 'Bearer ABCDEFGHIJKLMNOPQRSTUV',
              note: 'invocation prose',
            },
          },
        },
      },
    );

    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
    const content = body.params.arguments.content as string;
    expect(content).not.toContain(capSplitCanary);
    expect(content).not.toContain('sk-cap-');
    expect(content).not.toContain('structured-request-canary');
    expect(content).not.toContain('service-key-canary');
    expect(content).not.toContain('ABCDEFGHIJKLMNOPQRSTUV');
    expect(content).toContain('[REDACTED]');
    expect(content).toContain('ordinary prose');
    expect(content).toContain('invocation prose');
  });

  it('redacts response-side credentials while preserving ordinary hashes, ids, URLs, and prose', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => 'event: message\ndata: {"result":{"content":[{"type":"text","text":"captured"}]},"jsonrpc":"2.0","id":1}\n\n',
    });
    vi.stubGlobal('fetch', fetchMock);
    const sha = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const uuid = '123e4567-e89b-12d3-a456-426614174000';
    const chatId = '1491979880747765810';
    const url = 'https://example.test/path?mode=safe';

    await captureClaudeHookEvent(
      { agentId: 'eli', endpointUrl: 'https://example.test/open-brain', agentMemoryKey: 'agent-secret' },
      'PostToolUse',
      {
        session_id: 'response-redaction',
        tool_name: 'Read',
        tool_response: { client_secret: 'structured-response-canary', sha, uuid },
        tool_output: `safe prose ${chatId} ${url}`,
        result: { accessToken: 'result-token-canary', message: 'completed normally' },
      },
    );

    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
    const content = body.params.arguments.content as string;
    expect(content).not.toContain('structured-response-canary');
    expect(content).not.toContain('result-token-canary');
    expect(content).toContain(sha);
    expect(content).toContain(uuid);
    expect(content).toContain(chatId);
    expect(content).toContain(url);
    expect(content).toContain('safe prose');
    expect(content).toContain('completed normally');
  });

  it('captures Claude user prompts directly as private_agent context', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => 'event: message\ndata: {"result":{"content":[{"type":"text","text":"captured"}]},"jsonrpc":"2.0","id":1}\n\n',
    });
    vi.stubGlobal('fetch', fetchMock);

    await captureClaudePromptEvent(
      { agentId: 'marcus', endpointUrl: 'https://example.test/open-brain', agentMemoryKey: 'agent-secret' },
      '<channel source="discord" chat_id="c1">Ship it</channel>',
      {
        session_id: 's1',
        prompt_id: 'p1',
        cwd: '/Volumes/Repo-Drive/src/frontdesk',
      },
    );

    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
    expect(body.params.arguments.agent_id).toBe('marcus');
    expect(body.params.arguments.scope).toBe('private_agent');
    expect(body.params.arguments.authority).toBe('context');
    expect(body.params.arguments.confidence).toBe(0.7);
    expect(body.params.arguments.project).toBe('frontdesk');
    expect(body.params.arguments.source_type).toBe('claude_prompt');
    expect(body.params.arguments.source_ref).toBe('claude-prompt:s1:p1');
    expect(body.params.arguments.content).toBe('Ship it');
    expect(body.params.arguments.content).not.toContain('<channel source=');
  });

  it('strips injected answer-context envelopes before capturing prompts', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => 'event: message\ndata: {"result":{"content":[{"type":"text","text":"captured"}]},"jsonrpc":"2.0","id":1}\n\n',
    });
    vi.stubGlobal('fetch', fetchMock);

    await captureClaudePromptEvent(
      { agentId: 'isla', endpointUrl: 'https://example.test/open-brain', agentMemoryKey: 'agent-secret' },
      '<answer_context><governed_memory>previous: shared_team source_of_truth</governed_memory></answer_context>\n\n<channel source="discord">What tire size on a Honda Insight?</channel>',
      {
        session_id: 's2',
        prompt_id: 'p2',
        cwd: '/Volumes/Repo-Drive/agents/isla',
      },
    );

    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
    expect(body.params.arguments.content).not.toContain('<answer_context>');
    expect(body.params.arguments.content).not.toContain('<channel');
    expect(body.params.arguments.content).not.toContain('shared_team');
    expect(body.params.arguments.content).not.toContain('source_of_truth');
    expect(body.params.arguments.content).toBe('What tire size on a Honda Insight?');
    expect(body.params.arguments.content).toContain('Honda Insight');
    expect(body.params.arguments.project).toBe('agent:isla');
  });

  it('falls back to agent-runtime project when cwd is unknown', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => 'event: message\ndata: {"result":{"content":[{"type":"text","text":"captured"}]},"jsonrpc":"2.0","id":1}\n\n',
    });
    vi.stubGlobal('fetch', fetchMock);

    await captureClaudePromptEvent(
      { agentId: 'eli', endpointUrl: 'https://example.test/open-brain', agentMemoryKey: 'agent-secret' },
      '<channel>routine</channel>',
      { session_id: 's3', prompt_id: 'p3' }, // no cwd
    );

    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
    expect(body.params.arguments.project).toBe('agent-runtime');
  });

  it('does not throw when capture_agent_memory fails (non-blocking)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'edge function error',
    });
    vi.stubGlobal('fetch', fetchMock);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await expect(
      captureClaudePromptEvent(
        { agentId: 'isla', endpointUrl: 'https://example.test/open-brain', agentMemoryKey: 'agent-secret' },
        '<channel>capture-must-not-block-turn</channel>',
        { session_id: 's4', prompt_id: 'p4', cwd: '/Volumes/Repo-Drive/agents/isla' },
      ),
    ).resolves.toBeUndefined();

    expect(stderrSpy).toHaveBeenCalled();
    stderrSpy.mockRestore();
  });

  it('uses idempotent source_ref so retries do not duplicate captures', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => 'event: message\ndata: {"result":{"content":[{"type":"text","text":"captured"}]},"jsonrpc":"2.0","id":1}\n\n',
    });
    vi.stubGlobal('fetch', fetchMock);

    const config = { agentId: 'isla', endpointUrl: 'https://example.test/open-brain', agentMemoryKey: 'agent-secret' };
    const payload = { session_id: 'sess-abc', prompt_id: 'prompt-xyz', cwd: '/Volumes/Repo-Drive/agents/isla' };
    const promptText = '<channel>same content twice</channel>';

    await captureClaudePromptEvent(config, promptText, payload);
    await captureClaudePromptEvent(config, promptText, payload);

    const firstBody = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
    const secondBody = JSON.parse(fetchMock.mock.calls[1]?.[1]?.body as string);
    expect(firstBody.params.arguments.source_ref).toBe(secondBody.params.arguments.source_ref);
    expect(firstBody.params.arguments.source_ref).toBe('claude-prompt:sess-abc:prompt-xyz');
  });

  it('uses a stable content-derived source_ref when prompt_id is missing', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => 'event: message\ndata: {"result":{"content":[{"type":"text","text":"captured"}]},"jsonrpc":"2.0","id":1}\n\n',
    });
    vi.stubGlobal('fetch', fetchMock);

    const config = { agentId: 'isla', endpointUrl: 'https://example.test/open-brain', agentMemoryKey: 'agent-secret' };
    const payload = { session_id: 'sess-no-prompt-id', cwd: '/Volumes/Repo-Drive/agents/isla' };
    const promptText = '<channel>same content without prompt id</channel>';

    await captureClaudePromptEvent(config, promptText, payload);
    await captureClaudePromptEvent(config, promptText, payload);

    const firstBody = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
    const secondBody = JSON.parse(fetchMock.mock.calls[1]?.[1]?.body as string);
    expect(firstBody.params.arguments.source_ref).toBe(secondBody.params.arguments.source_ref);
    expect(firstBody.params.arguments.source_ref).toMatch(/^claude-prompt:sess-no-prompt-id:sha256-[a-f0-9]{16}$/);
  });

  it('captures Discord reply tool text directly to private_agent context', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => 'event: message\ndata: {"result":{"content":[{"type":"text","text":"captured"}]},"jsonrpc":"2.0","id":1}\n\n',
    });
    vi.stubGlobal('fetch', fetchMock);

    await captureClaudeHookEvent(
      { agentId: 'marcus', endpointUrl: 'https://example.test/open-brain', agentMemoryKey: 'agent-secret' },
      'PostToolUse',
      {
        session_id: 's1',
        cwd: '/Volumes/Repo-Drive/src/mcc-tmux',
        tool_name: 'mcp__plugin_discord_discord__reply',
        tool_input: {
          chat_id: '1491979880747765810',
          text: 'Done. I shipped the title update.',
        },
      },
    );

    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
    expect(body.params.arguments.scope).toBe('private_agent');
    expect(body.params.arguments.authority).toBe('context');
    expect(body.params.arguments.confidence).toBe(0.7);
    expect(body.params.arguments.project).toBe('mcc-tmux');
    expect(body.params.arguments.source_type).toBe('discord_reply');
    expect(body.params.arguments.content).toContain('Tool name: mcp__plugin_discord_discord__reply');
    expect(body.params.arguments.content).toContain('Chat ID: 1491979880747765810');
    expect(body.params.arguments.content).toContain('Discord text excerpt: Done. I shipped the title update.');
  });

  it('keeps non-Discord claude_hook telemetry in raw_capture', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => 'event: message\ndata: {"result":{"content":[{"type":"text","text":"captured"}]},"jsonrpc":"2.0","id":1}\n\n',
    });
    vi.stubGlobal('fetch', fetchMock);

    await captureClaudeHookEvent(
      { agentId: 'isla', endpointUrl: 'https://example.test/open-brain', agentMemoryKey: 'agent-secret' },
      'PostToolUse',
      {
        session_id: 'edit-session',
        cwd: '/Volumes/Repo-Drive/src/mcc-tmux',
        tool_name: 'Edit',
        tool_input: {
          file_path: '/Volumes/Repo-Drive/src/mcc-tmux/foo.ts',
          old_string: 'old',
          new_string: 'new',
        },
      },
    );

    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
    expect(body.params.arguments.scope).toBe('raw_capture');
    expect(body.params.arguments.authority).toBe('raw_capture');
    expect(body.params.arguments.source_type).toBe('claude_hook');
    expect(body.params.arguments.confidence).toBe('medium');
    expect(body.params.arguments.project).toBe('agent-runtime');
  });

  it('captures successful Codex Discord replies as outbound raw captures', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => 'event: message\ndata: {"result":{"content":[{"type":"text","text":"captured"}]},"jsonrpc":"2.0","id":1}\n\n',
    });
    vi.stubGlobal('fetch', fetchMock);

    await captureClaudeHookEvent(
      { agentId: 'eli', endpointUrl: 'https://example.test/open-brain', agentMemoryKey: 'agent-secret' },
      'PostToolUse',
      {
        invocation: {
          server: 'discord-eli',
          tool: 'reply',
          arguments: {
            chat_id: '1491979880747765810',
            text: 'Patch is verified.',
          },
        },
        result: {
          Ok: {
            content: [{ type: 'text', text: 'sent (id: 1499966336564986067)' }],
          },
        },
      },
    );

    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
    expect(body.params.arguments.source_type).toBe('discord_reply');
    expect(body.params.arguments.source_ref).toBe('discord-reply:1499966336564986067');
    expect(body.params.arguments.content).toContain('Codex MCP server: discord-eli');
    expect(body.params.arguments.content).toContain('Codex MCP tool: reply');
    expect(body.params.arguments.content).toContain('Codex chat ID: 1491979880747765810');
    expect(body.params.arguments.content).toContain('Codex Discord text excerpt: Patch is verified.');
  });

  it('does not reintroduce raw credentials while extracting a Discord result id', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => 'event: message\ndata: {"result":{"content":[{"type":"text","text":"captured"}]},"jsonrpc":"2.0","id":1}\n\n',
    });
    vi.stubGlobal('fetch', fetchMock);

    await captureClaudeHookEvent(
      { agentId: 'eli', endpointUrl: 'https://example.test/open-brain', agentMemoryKey: 'agent-secret' },
      'PostToolUse',
      {
        invocation: {
          server: 'discord-eli',
          tool: 'reply',
          arguments: { chat_id: '1491979880747765810', text: 'safe reply' },
        },
        result: {
          access_token: 'discord-result-token-canary',
          message: 'sent (id: 1499966336564986067)',
        },
      },
    );

    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
    expect(body.params.arguments.source_ref).toBe('discord-reply:1499966336564986067');
    expect(body.params.arguments.content).not.toContain('discord-result-token-canary');
    expect(body.params.arguments.content).toContain('[REDACTED]');
  });

  it('skips Claude lifecycle captures without substantive evidence', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await captureClaudeHookEvent(
      { agentId: 'isla', endpointUrl: 'https://example.test/open-brain', agentMemoryKey: 'agent-secret' },
      'SessionEnd',
      {
        cwd: '/Volumes/Repo-Drive/agents/isla',
        session_id: 's1',
      },
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
