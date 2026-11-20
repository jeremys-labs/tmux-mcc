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
      // COMPOUND-BOUNDARY POSITIVES (dc-20261119-010): what the narrowed B2 must still reach.
      [`apiKey: ${SYNTH}`, 'camel-case hump'],
      [`SigningKey: ${SYNTH}`, 'camel hump after a capitalised word'],
      [`x-api-key: ${SYNTH}`, 'hyphen delimiter, the HTTP header spelling'],
      [`my.key: ${SYNTH}`, 'dot delimiter'],
      [`session-key=${SYNTH}`, 'hyphen delimiter with `=`'],
      // ACCEPTED RESIDUAL, PINNED BOTH WAYS (isla, 2026-11-19): all-caps has no delimiter and no
      // case hump, so these two are indistinguishable BY SHAPE. APIKEY is REQUIRED -- it would
      // leave for a third party via getEmbedding and could not be recalled. MONKEY is the cost.
      [`APIKEY: ${SYNTH}`, 'REQUIRED: all-caps compound with no delimiter'],
      ['MONKEY: Curious77', 'ACCEPTED RESIDUAL: all-caps prose, indistinguishable from APIKEY'],
      // INVERTED TO AN ALLOWLIST (isla, 2026-11-20). These are not covered by a list of credential
      // stems any more -- a word ending in `key` redacts BY DEFAULT and only the prose allowlist is
      // exempt, so a credential compound nobody wrote down is covered without being named. The seven
      // below are eli's: every one redacted on origin/main and leaked under the closed stem list.
      // One row each so each is separately deletable and separately named in a failure.
      [`secretkey: Abcdefg123`, 'credential compound, redacts by default: secret'],
      [`accesskey: Abcdefg123`, 'credential compound, redacts by default: access'],
      [`privatekey: Abcdefg123`, 'credential compound, redacts by default: private'],
      [`signingkey: Abcdefg123`, 'credential compound, redacts by default: signing'],
      [`masterkey: Abcdefg123`, 'credential compound, redacts by default: master'],
      [`encryptionkey: Abcdefg123`, 'credential compound, redacts by default: encryption'],
      [`licensekey: Abcdefg123`, 'credential compound, redacts by default: license'],
      [`clientkey: Abcdefg123`, 'credential compound, redacts by default: client'],
      [`sshkey: Abcdefg123`, 'credential compound, redacts by default: ssh'],
      [`sessionkey: Abcdefg123`, 'credential compound, redacts by default: session'],
      [`authkey: Abcdefg123`, 'credential compound, redacts by default: auth'],
      [`appkey: Abcdefg123`, 'credential compound, redacts by default: app'],
      [`servicekey: Abcdefg123`, 'credential compound, redacts by default: service'],
      [`deploykey: Abcdefg123`, 'credential compound, redacts by default: deploy'],
      [`webhookkey: Abcdefg123`, 'credential compound, redacts by default: webhook'],
      [`accountkey: Abcdefg123`, 'credential compound, redacts by default: account'],
      [`rootkey: Abcdefg123`, 'credential compound, redacts by default: root'],
      [`consumerkey: Abcdefg123`, 'credential compound, redacts by default: consumer'],
      [`passkey: Abcdefg123`, 'credential compound, redacts by default: pass'],
      [`publickey: Abcdefg123`, 'credential compound, redacts by default: public'],
      [`pubkey: Abcdefg123`, 'credential compound, redacts by default: pub'],
      [`hostkey: Abcdefg123`, 'credential compound, redacts by default: host'],
      [`gpgkey: Abcdefg123`, 'credential compound, redacts by default: gpg'],
      [`hmackey: Abcdefg123`, 'credential compound, redacts by default: hmac'],
      [`cipherkey: Abcdefg123`, 'credential compound, redacts by default: cipher'],
      [`symmetrickey: Abcdefg123`, 'credential compound, redacts by default: symmetric'],
      [`apikey: Abcdefg123`, 'credential compound, redacts by default: api'],
      [`botkey: Abcdefg123`, 'credential compound, redacts by default: bot'],
      [`sharedkey: Abcdefg123`, 'credential compound, redacts by default: shared'],
      ['databasekey: Abcdefg123', 'eli 2026-11-20: leaked under the closed stem list'],
      ['dbkey: Abcdefg123', 'eli 2026-11-20: leaked under the closed stem list'],
      ['storagekey: Abcdefg123', 'eli 2026-11-20: leaked under the closed stem list'],
      ['cloudkey: Abcdefg123', 'eli 2026-11-20: leaked under the closed stem list'],
      ['kmskey: Abcdefg123', 'eli 2026-11-20: leaked under the closed stem list'],
      ['recoverykey: Abcdefg123', 'eli 2026-11-20: leaked under the closed stem list'],
      ['devicekey: Abcdefg123', 'eli 2026-11-20: leaked under the closed stem list'],
      ['latchkey: Curious77', 'DELIBERATELY NOT EXEMPT: a house key is still a key name'],
      ['turnkey: Curious77', 'DELIBERATELY NOT EXEMPT: prose as `turnkey solution`, but it is a key name'],
      ['passkey: Curious77', 'DELIBERATELY NOT EXEMPT: in the dictionary AND a key name'],
      ['monkeyKey: Abcdefg123', 'allowlisted word must END the token to be exempt'],
      ['monkey_key: Abcdefg123', 'allowlisted word must END the token to be exempt'],
      [`mysecretkey: ${SYNTH}`, 'prefix before the stem'],
      [`appsecretkey: ${SYNTH}`, 'prefix that is itself a stem'],
      ['Secretkey: Abcdefg123', 'capitalised stem'],
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
      // KEY-BOUNDARY ROWS (dc-20261119-010). THIS COPY HAD NONE, and it is the copy the capture
      // path actually runs -- for this defect class it was pinned only by the byte-identity test
      // in the open-brain repo, which swallows NotFound and therefore passes when it cannot find
      // this file at all. Every value below is 8+ chars with an uppercase AND a digit, so it
      // SATISFIES B2's value guard and the row can only pass if the KEY boundary holds. Every
      // pre-existing row above is excluded by the value rule, the separator rule or length, so
      // not one of them could exercise the boundary, and `monkey: Curious77` redacted on main.
      ['monkey: Curious77', "eli's case: an ordinary word ending in `key`"],
      ['turkey: Dinner99', "eli's case"],
      ['hockey: League88', "eli's case"],
      ['donkey: Animal77', "eli's case"],
      ['whiskey: Barrel77', 'mine: found by probing past the reported four'],
      ['lackey: Servant99', 'mine'],
      ['jockey: Rider888', 'mine: 8-char value ON PURPOSE -- `Rider88` is 7 and passes vacuously'],
      ['malarkey: Nonsense8', 'mine'],
      ['mickey: Mouse1234', 'mine'],
      ['Monkey: Curious77', 'capitalised prose: a leading capital is not a camel hump'],
      ['The monkey: Curious77 was noted', 'mid-sentence: destroys prose, not just a line'],
      // THE PROSE ALLOWLIST, and the direction of its residual is the point: an entry nobody added
      // is an OVER-redaction, never a leak. No entry may be the name of a key -- `latchkey`,
      // `turnkey` and `passkey` are in the dictionary and are deliberately in the positive table.
      ['hickey: Blemish77', 'prose allowlist member'],
      ['dickey: Shirt9999', 'prose allowlist member'],
      ['pokey: Slowly777', 'prose allowlist member'],
      ['hokey: Cheesy888', 'prose allowlist member'],
      ['doohickey: Gadget777', 'prose allowlist member'],
      ['flunkey: Curious77', 'real word ending in `key`, no stem before it'],
      ['smokey: Curious77', 'real word ending in `key`, no stem before it'],
      ['lowkey: Curious77', 'real word ending in `key`, no stem before it'],
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
      expect(MUST_REDACT.length).toBeGreaterThanOrEqual(66);
      expect(MUST_NOT_REDACT.length).toBeGreaterThanOrEqual(31);
      const pos = new Set(MUST_REDACT.map(([i]) => i));
      for (const [input] of MUST_NOT_REDACT) expect(pos.has(input)).toBe(false);
    });

    // A long, disjoint negative table can still be entirely non-discriminating: a row is "not
    // redacted" if ANY of B2's conditions fails, so a table whose every row fails the VALUE rule
    // says nothing about the KEY boundary. That is exactly how this defect reached main. A row is
    // a key-boundary discriminator only if swapping its key for a known-good key makes it redact
    // -- a property of the row, checked here, not a claim in a comment.
    it('the negative table actually exercises the key boundary', () => {
      // THE SENTINEL MUST BE MATCHED BY B2 ALONE, and `api_key` is not: patterns 10 and 11 redact
      // it WITHOUT requiring an uppercase and a digit, so every row counted -- including seven
      // pre-existing rows that cannot exercise B2 -- and all-lowercase values still produced 24.
      // The control written to detect vacuous coverage was itself vacuous. Codex, fe5b34a2.
      const B2_ONLY_KEY = 'signing_key';
      expect(
        redactString(`${B2_ONLY_KEY}: lowercasevalue`),
        'sentinel is not B2-only: another pattern redacts it regardless of value shape, which ' +
          'makes every discriminator count below meaningless',
      ).toBe(`${B2_ONLY_KEY}: lowercasevalue`);

      const discriminators = MUST_NOT_REDACT.filter(([input]) => {
        const swapped = input.replace(/[A-Za-z0-9_.-]+(\s*["']?\s*[:=])/, `${B2_ONLY_KEY}$1`);
        return swapped !== input && redactString(swapped) !== swapped;
      });
      expect(
        discriminators.length,
        "negative rows whose value satisfies B2's value guard; the rest pass for an unrelated " +
          'reason and prove nothing about the key boundary',
      ).toBeGreaterThanOrEqual(19);
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
