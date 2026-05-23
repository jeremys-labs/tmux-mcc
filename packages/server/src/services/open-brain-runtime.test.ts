import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  callOpenBrainTool,
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
