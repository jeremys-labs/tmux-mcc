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
    /**
     * THE TIER-B TABLES, mirrored from OB1's vendored copy (dc-20261119-007). This file is the
     * SOURCE OF TRUTH for the detector, so the policy table belongs here too -- a widened
     * vocabulary that only one copy's tests describe is a vocabulary that can drift in meaning
     * while both pattern blocks stay byte-identical.
     *
     * All values are SHAPE-MATCHING SYNTHETIC. The test suite for a redactor is a leak surface.
     */
    const SYNTH = 'SYNTHxQ7mK2pL9vR4tW8yZ3n';
    const MUST_REDACT: Array<[string, string]> = [
      ['db_password=correcthorsebattery', "isla's case: the commonest real password shape"],
      ['password: hunter2horse', 'a memory does not need to keep the value'],
      ['client_secret: alllowercasesecret', 'no digit, no uppercase, still a secret'],
      [`GITHUB_TOKEN=${SYNTH}`, 'bare TOKEN was not in the old vocabulary'],
      [`SECRET_KEY=${SYNTH}`, 'the old UPPER pattern required a char BEFORE the keyword'],
      [`private_key=${SYNTH}`, 'compound strong key'],
      // DISCRIMINATING ROW: no uppercase and no digit, so B2 cannot reach it and only B1's
      // `private_key` alternative can. The battery showed the row above is caught by B2 too.
      ['private_key: alllowercasekeyvalue', "B1-only: B2's value rule excludes this"],
      [`aws_secret_access_key=${SYNTH}`, 'deep compound, matched on `secret`'],
      [`webhook_secret=${SYNTH}`, 'suffix `_secret`'],
      [`session_token: ${SYNTH}`, 'suffix `_token`, colon separator'],
      [`credentials=${SYNTH}`, 'lowercase `credentials` was UPPER-only before'],
      [`signing_key=${SYNTH}`, 'ambiguous key, credential-shaped value'],
      [`access_key: ${SYNTH}`, 'ambiguous key, colon separator'],
      [`jwt=${SYNTH}`, 'ordinary word as a key, credential-shaped value'],
      [`pat: ${SYNTH}`, 'given name as a key, credential-shaped value'],
    ];
    const MUST_NOT_REDACT: Array<[string, string]> = [
      ['token budget: 5', 'value too short'],
      ['the key: idea', 'bare `key` is not in the vocabulary'],
      ['password reset email', 'no separator at all'],
      ['primary_key: customer_identifier', "isla's case: schema talk, no uppercase and no digit"],
      ['foreign_key: orders_customer_id', 'schema talk'],
      ['primary_key: CUSTOMER_ID', 'uppercase but NO DIGIT -- why the rule needs both'],
      ['sort_key: ts_bucket_2024', 'digit but NO UPPERCASE -- the other half'],
      ['signing_key: rotated_last_week', 'ambiguous key, prose value'],
      ['Pat: Christopher Lahners', 'a person, not a credential'],
      ['jwt: structure has three parts', 'prose about a format'],
      ['we discussed the access_key naming convention', 'no separator'],
      ['the api_key rotation is scheduled', 'no separator'],
    ];

    // ONE TEST PER ROW, not one over the table: a single test means every vocabulary mutation
    // reddens the SAME test, so deleting it would unpin the whole vocabulary at once.
    it.each(MUST_REDACT)('tier B redacts: %s', (input, why) => {
      const out = redactString(input);
      expect(out, why).toContain('[REDACTED]');
      const value = input.split(/[:=]/).slice(1).join('').trim().replace(/^["']/, '');
      expect(out.includes(value), `${why}: value survived`).toBe(false);
    });

    it.each(MUST_NOT_REDACT)('tier B leaves alone: %s', (input, why) => {
      expect(redactString(input), `${why}: wrongly redacted`).toBe(input);
    });

    it('tier B tables are non-vacuous and disjoint', () => {
      expect(MUST_REDACT.length).toBeGreaterThanOrEqual(14);
      expect(MUST_NOT_REDACT.length).toBeGreaterThanOrEqual(12);
      const pos = new Set(MUST_REDACT.map(([i]) => i));
      for (const [input] of MUST_NOT_REDACT) expect(pos.has(input)).toBe(false);
    });

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

    it('redacts values under sensitive keys without hiding ordinary identifiers', () => {
      const input = {
        password: 'not-a-real-password',
        api_key: 'not-a-real-api-key',
        SUPABASE_SECRET_KEY: 'not-a-real-service-key',
        nested: { refreshToken: 'not-a-real-refresh-token' },
        sha: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        uuid: '123e4567-e89b-12d3-a456-426614174000',
        chat_id: '1491979880747765810',
        max_tokens: 4096,
        url: 'https://example.test/path?mode=safe',
      };

      expect(redactPayload(input)).toEqual({
        password: '[REDACTED]',
        api_key: '[REDACTED]',
        SUPABASE_SECRET_KEY: '[REDACTED]',
        nested: { refreshToken: '[REDACTED]' },
        sha: input.sha,
        uuid: input.uuid,
        chat_id: input.chat_id,
        max_tokens: input.max_tokens,
        url: input.url,
      });
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
