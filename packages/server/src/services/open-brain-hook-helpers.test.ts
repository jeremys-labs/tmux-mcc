import { describe, expect, it, vi } from 'vitest';
import {
  formatClaudeAdditionalContext,
  formatCodexSystemMessage,
  formatRuntimeContextOutput,
  parseOpenBrainHookArgs,
  redactPayload,
  redactString,
  runOpenBrainHarnessHook,
} from './open-brain-hook-helpers.js';

describe('open-brain-hook-helpers', () => {
  describe('parseOpenBrainHookArgs', () => {
    it('defaults to claude format', () => {
      expect(parseOpenBrainHookArgs(['session-start'])).toEqual({
        command: 'session-start',
        outputFormat: 'claude',
      });
    });

    it('accepts --format codex', () => {
      expect(parseOpenBrainHookArgs(['answer-context', '--format', 'codex'])).toEqual({
        command: 'answer-context',
        outputFormat: 'codex',
      });
    });

    it('throws on unknown command', () => {
      expect(() => parseOpenBrainHookArgs(['nope'])).toThrow(/Usage:/);
    });
  });

  describe('redaction', () => {
    it('redacts secrets in nested payload structures', () => {
      const input = {
        prompt: 'use sk-test-AAAAAAAAAAAAAAAAAAAAAAAA to call the API',
        nested: {
          headers: ['Authorization Bearer abcdefghijklmnopqrstuv', 'X-Other: safe'],
          jwt: 'eyJabc.eyJdef.signaturepartABC',
          aws: 'AKIA0123456789ABCDEF',
          gh: 'ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        },
        unaffected: 42,
      };
      const out = redactPayload(input);
      expect(out.prompt).not.toContain('sk-test-AAAAAAAAAAAAAAAAAAAAAAAA');
      expect(out.prompt).toContain('[REDACTED]');
      expect(out.nested.headers[0]).toContain('[REDACTED]');
      expect(out.nested.headers[1]).toBe('X-Other: safe');
      expect(out.nested.jwt).toBe('[REDACTED]');
      expect(out.nested.aws).toBe('[REDACTED]');
      expect(out.nested.gh).toBe('[REDACTED]');
      expect(out.unaffected).toBe(42);
    });

    it('returns non-strings unchanged from redactString', () => {
      expect(redactString(42 as unknown as string)).toBe(42);
    });
  });

  describe('runtime envelope formatting', () => {
    it('wraps Claude SessionStart context in hookSpecificOutput', () => {
      const out = formatRuntimeContextOutput('claude', 'SessionStart', 'hello');
      expect(JSON.parse(out)).toEqual({
        hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'hello' },
      });
    });

    it('wraps Codex output as systemMessage with continue:true', () => {
      const out = formatRuntimeContextOutput('codex', 'UserPromptSubmit', 'hello');
      expect(JSON.parse(out)).toEqual({ continue: true, systemMessage: 'hello' });
    });

    it('returns empty string when context is empty', () => {
      expect(formatRuntimeContextOutput('claude', 'SessionStart', '')).toBe('');
      expect(formatRuntimeContextOutput('codex', 'UserPromptSubmit', '')).toBe('');
    });

    it('formatClaudeAdditionalContext and formatCodexSystemMessage emit valid JSON', () => {
      expect(JSON.parse(formatClaudeAdditionalContext('Foo', 'bar'))).toMatchObject({
        hookSpecificOutput: { hookEventName: 'Foo', additionalContext: 'bar' },
      });
      expect(JSON.parse(formatCodexSystemMessage('msg'))).toMatchObject({
        continue: true,
        systemMessage: 'msg',
      });
    });
  });

  describe('runOpenBrainHarnessHook fail-open', () => {
    const baseHandlers = {
      resolveStartupContext: vi.fn(async () => 'startup'),
      resolveAnswerContext: vi.fn(async () => 'answer'),
      captureEvent: vi.fn(async () => undefined),
    };

    it('returns empty string when resolveStartupContext throws', async () => {
      const handlers = {
        ...baseHandlers,
        resolveStartupContext: vi.fn(async () => {
          throw new Error('boom');
        }),
      };
      const out = await runOpenBrainHarnessHook(
        { command: 'session-start', outputFormat: 'claude', payload: {} },
        handlers,
      );
      expect(out).toBe('');
    });

    it('returns empty string when resolveAnswerContext throws', async () => {
      const handlers = {
        ...baseHandlers,
        resolveAnswerContext: vi.fn(async () => {
          throw new Error('boom');
        }),
      };
      const out = await runOpenBrainHarnessHook(
        { command: 'answer-context', outputFormat: 'claude', payload: { prompt: 'hi' } },
        handlers,
      );
      expect(out).toBe('');
    });

    it('skips answer-context when prompt is empty', async () => {
      const resolveAnswerContext = vi.fn(async () => 'should not run');
      const out = await runOpenBrainHarnessHook(
        { command: 'answer-context', outputFormat: 'claude', payload: {} },
        { ...baseHandlers, resolveAnswerContext },
      );
      expect(out).toBe('');
      expect(resolveAnswerContext).not.toHaveBeenCalled();
    });

    it('passes redacted payload to captureEvent (secrets stripped before handler)', async () => {
      const captureEvent = vi.fn(async () => undefined);
      await runOpenBrainHarnessHook(
        {
          command: 'capture',
          outputFormat: 'claude',
          payload: {
            hook_event_name: 'PostToolUse',
            tool_input: { content: 'token sk-leak-AAAAAAAAAAAAAAAAAAAAAAAA here' },
          },
        },
        { ...baseHandlers, captureEvent },
      );
      expect(captureEvent).toHaveBeenCalledTimes(1);
      const [, eventName, payload] = captureEvent.mock.calls[0]!;
      expect(eventName).toBe('PostToolUse');
      const passedContent = (payload as { tool_input: { content: string } }).tool_input.content;
      expect(passedContent).not.toContain('sk-leak');
      expect(passedContent).toContain('[REDACTED]');
    });

    it('returns empty when captureEvent throws (fail-open)', async () => {
      const handlers = {
        ...baseHandlers,
        captureEvent: vi.fn(async () => {
          throw new Error('downstream failure');
        }),
      };
      const out = await runOpenBrainHarnessHook(
        { command: 'capture', outputFormat: 'claude', payload: { hook_event_name: 'PostToolUse' } },
        handlers,
      );
      expect(out).toBe('');
    });

    it('fails open on handler timeout', async () => {
      const slowHandler = vi.fn(
        () => new Promise<string>((resolve) => setTimeout(() => resolve('too late'), 50)),
      );
      const out = await runOpenBrainHarnessHook(
        {
          command: 'session-start',
          outputFormat: 'claude',
          payload: {},
          timeoutMs: 5,
        },
        { ...baseHandlers, resolveStartupContext: slowHandler },
      );
      expect(out).toBe('');
    });

    it('returns formatted Claude envelope on successful startup', async () => {
      const out = await runOpenBrainHarnessHook(
        { command: 'session-start', outputFormat: 'claude', payload: {} },
        baseHandlers,
      );
      expect(JSON.parse(out)).toEqual({
        hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'startup' },
      });
    });
  });
});
