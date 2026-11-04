import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { createCodexInjectionGate } from './runtime-codex-injection.js';

let dir: string;
let logPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-log-'));
  logPath = path.join(dir, 'agent.log');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.resetModules();
});

/**
 * The bound is read at module scope, so a test that wants a small bound has to set the env BEFORE
 * the module is evaluated. Importing dynamically after `vi.stubEnv` is what makes the bound's
 * FIRING demonstrable -- the row's acceptance (b) asks for the file driven PAST the bound, and a
 * bound only reachable by writing 8 MiB is a bound nobody ever shows working.
 */
async function loadWriter(maxBytes?: number, rawKnob?: string) {
  vi.resetModules();
  if (rawKnob !== undefined) vi.stubEnv('RUNTIME_LOG_MAX_BYTES', rawKnob);
  else if (maxBytes !== undefined) vi.stubEnv('RUNTIME_LOG_MAX_BYTES', String(maxBytes));
  return await import('./runtime-log.js');
}

describe('appendRuntimeLogLine: acceptance (b), the log is bounded', () => {
  it('writes one timestamped line per call, and the message is the caller`s only contribution', async () => {
    const { appendRuntimeLogLine } = await loadWriter();
    appendRuntimeLogLine(logPath, 'gate opened');

    const lines = fs.readFileSync(logPath, 'utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(1);
    // The timestamp belongs to the writer, which is what makes the file greppable by prefix.
    expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z gate opened$/);
  });

  it('ROTATES once the file reaches the bound, so the live file does not grow unbounded', async () => {
    const { appendRuntimeLogLine, RUNTIME_LOG_MAX_BYTES } = await loadWriter(2048);
    expect(RUNTIME_LOG_MAX_BYTES).toBe(2048);

    // Drive it past the bound, which is what acceptance (b) asks for.
    for (let i = 0; i < 60; i += 1) appendRuntimeLogLine(logPath, `signal line ${i} ${'x'.repeat(60)}`);

    expect(fs.existsSync(`${logPath}.1`)).toBe(true);
    expect(fs.statSync(logPath).size).toBeLessThan(2048);
    // ONE generation, so total on-disk use is bounded by 2x the bound rather than by nothing.
    expect(fs.existsSync(`${logPath}.2`)).toBe(false);
    expect(fs.statSync(logPath).size + fs.statSync(`${logPath}.1`).size)
      .toBeLessThanOrEqual(2 * 2048 + 200);
  });

  it('keeps exactly one previous generation across MANY rotations, not one per rotation', async () => {
    const { appendRuntimeLogLine } = await loadWriter(1024);
    for (let i = 0; i < 300; i += 1) appendRuntimeLogLine(logPath, `line ${i} ${'y'.repeat(80)}`);

    const generations = fs.readdirSync(dir).filter((f) => f.startsWith('agent.log.'));
    expect(generations).toEqual(['agent.log.1']);
  });

  it('STILL APPENDS when rotation fails, because the explicit non-goal is that signal lines keep appearing', async () => {
    const { appendRuntimeLogLine } = await loadWriter(1024);
    // An unrotatable target: renaming onto a non-empty directory fails.
    fs.mkdirSync(`${logPath}.1`);
    fs.writeFileSync(path.join(`${logPath}.1`, 'occupied'), 'x');
    fs.writeFileSync(logPath, 'z'.repeat(2048));

    expect(() => appendRuntimeLogLine(logPath, 'FAULT codex runtime unreachable')).not.toThrow();
    expect(fs.readFileSync(logPath, 'utf8')).toContain('FAULT codex runtime unreachable');
  });
});

describe('acceptance (a): the prompt body never reaches the log', () => {
  it('logs the LENGTH and not the body, driven through the real injection gate and the real writer', async () => {
    const { appendRuntimeLogLine } = await loadWriter();
    const submit = vi.fn(async () => {});
    const gate = createCodexInjectionGate({
      waitForWindow: async () => 'idle',
      submit,
      retryBudget: 3,
      log: (line: string) => appendRuntimeLogLine(logPath, line),
    });

    // The distinctive string the row's acceptance (a) asks for.
    const prompt = 'please rotate SQUAMOUS-PANGOLIN-8821 before Friday';
    await gate.deliver(prompt, 'msg-1', 'mail');

    const text = fs.readFileSync(logPath, 'utf8');
    expect(submit).toHaveBeenCalledWith(prompt);          // the agent still receives the body
    expect(text).not.toContain('SQUAMOUS-PANGOLIN-8821'); // the log does not
    expect(text).toContain(`injecting mail msg-1: ${prompt.length} chars`);
  });
});

describe('acceptance (c): the log stays greppable for its OWN signal lines', () => {
  /**
   * THE 2026-10-01 FALSE READING, AS A REGRESSION TEST, and it is the reason this row is not
   * cosmetic. Because full bodies were logged, grepping the log for a signal token matched PROSE
   * INSIDE A QUOTED PROMPT: four apparent `oversized-fragment-dropped` hits were all design text
   * quoted back inside an injected message. A log that cannot be grepped for its own signal lines
   * is a degraded instrument, not merely a large file.
   *
   * The fixture is deliberately adversarial: the prompt body CONTAINS the signal token.
   */
  it('a prompt whose BODY contains a signal token produces no grep hit for it', async () => {
    const { appendRuntimeLogLine } = await loadWriter();
    const gate = createCodexInjectionGate({
      waitForWindow: async () => 'idle',
      submit: async () => {},
      retryBudget: 3,
      log: (line: string) => appendRuntimeLogLine(logPath, line),
    });

    // A real signal line, the kind the non-goal protects.
    appendRuntimeLogLine(logPath, 'oversized-fragment-dropped id=msg-7 bytes=91244');
    // ...and a message merely TALKING about it, which must not look like one.
    await gate.deliver('why did oversized-fragment-dropped fire four times?', 'msg-8', 'mail');

    const hits = fs.readFileSync(logPath, 'utf8')
      .trimEnd().split('\n')
      .filter((l) => l.includes('oversized-fragment-dropped'));

    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain('bytes=91244');
  });

  it('the signal lines themselves are NOT silenced, which is the row`s explicit non-goal', async () => {
    const { appendRuntimeLogLine } = await loadWriter();
    for (const signal of [
      'FAULT codex runtime never reached a prompt after 25 attempts',
      'gate opened for mail msg-3',
      'acknowledged mail msg-3',
      'codex readiness wait timed out for handoff; leaving handoff pending for retry',
    ]) {
      appendRuntimeLogLine(logPath, signal);
    }

    const text = fs.readFileSync(logPath, 'utf8');
    expect(text).toContain('FAULT codex runtime never reached a prompt after 25 attempts');
    expect(text).toContain('gate opened for mail msg-3');
    expect(text).toContain('acknowledged mail msg-3');
    expect(text).toContain('codex readiness wait timed out for handoff');
  });
});

/**
 * STRUCTURAL CONTROLS, REBUILT AFTER ISLA'S AND HERCULE'S REVIEWS OF THE FIRST VERSION.
 *
 * The first version had two defects they found between them, and both matter more than the fix:
 *
 *  - ISLA: it matched LINE BY LINE, so `claude-wrapper.ts`'s two MULTI-LINE `fs.appendFileSync(`
 *    calls were invisible to it. "Every write routes through the writer" was FALSE while the test
 *    PASSED -- a control reporting a property it could not see.
 *  - HERCULE: for a body-DISCLOSURE property a source-pinned control is weaker than for a
 *    behaviour one, and it earns its keep only by EVASION-RESISTANCE. A control that matches only
 *    the old inline shape lets a thin wrapper, an alias or a computed path write the log untouched.
 *
 * So the rule is now stated over the DESTINATION rather than over a spelling: in any file that
 * touches the runtime log, the only write API permitted is `appendRuntimeLogLine`. That catches an
 * alias and a thin wrapper, because either still has to name an append-capable fs API in a file
 * that also names the log.
 *
 * RESIDUAL LIMIT, STATED RATHER THAN GLOSSED: a source control cannot be made evasion-proof. A
 * brand-new file that computes the path from fragments and never mentions `runtime-state` or
 * `runtimeLogPath` would escape every one of these. That is why acceptance (a) also has an
 * end-to-end observation, and why the formatter exists -- the controls bound the ways in, they do
 * not prove there are none.
 */
describe('structural controls: the properties behaviour tests cannot reach here', () => {
  const SRC = path.resolve(__dirname, '..');
  const WRITER = path.join('services', 'runtime-log.ts');
  /**
   * `discord-direct-send.ts` appends to a variable also named `logPath`, but it is the discord-send
   * HEALTH log -- a different file. The exclusion is declared, and its precondition is asserted
   * below, so repointing that file at the runtime log fires the control instead of hiding in it.
   */
  const DECLARED_EXCEPTION = path.join('services', 'discord-direct-send.ts');

  const files = (): string[] => {
    const out: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.ts') && !e.name.includes('.test.')) out.push(p);
      }
    };
    walk(SRC);
    return out;
  };

  /**
   * The runtime log path, in the spellings the codebase uses for it.
   *
   * MY FIRST WIDENING WAS WRONG IN THE OTHER DIRECTION and its own failure caught it: I made the
   * population "any file that NAMES the runtime log", which flagged `replay-inbound.ts` and
   * `inbound-miss-recovery.ts` -- both legitimately append to a message INBOX and merely mention
   * the runtime log elsewhere. That is the same name-for-destination confusion as the
   * discord-direct-send exception, one level up, and the THIRD time today a predicate over a NAME
   * stood in for a question about a FILE. So the rule is back on the ARGUMENT, matched across
   * lines, which is what isla asked for.
   */
  const LOG_PATH_ARG = String.raw`(?:input\.)?(?:runtimeLogPath|logPath)`;

  /** Append- or write-capable APIs, in any spelling a bypass could reach for. */
  const WRITE_CALL = new RegExp(
    String.raw`(?:appendFileSync|appendFile|createWriteStream|writeFileSync|writeFile)\s*\(\s*` + LOG_PATH_ARG,
    's'
  );

  /**
   * Path helpers and reads: receiving the log path for these is not a write.
   */
  const PATH_HELPERS = new Set([
    'dirname', 'basename', 'join', 'resolve', 'relative',
    'existsSync', 'statSync', 'readFileSync', 'mkdirSync', 'rmSync', 'unlinkSync',
    'String', 'expect', 'if', 'for', 'while', 'return', 'switch',
  ]);

  /**
   * `runtime-a2a-poller.ts` is the SECOND declared exception, and isla found why it had to be:
   * its `logPath` is launchd's `StandardOutPath` for the poller, so putting it through a ROTATING
   * writer makes launchd's stdout follow the renamed inode and then an unlinked one. It is also
   * not a `runtime-state/<agent>.log` at all. Its precondition is asserted below.
   */
  const SECOND_EXCEPTION = path.join('services', 'runtime-a2a-poller.ts');

  const calleesReceivingLogPath = (text: string): string[] => {
    const re = new RegExp(String.raw`([A-Za-z_$][\w$]*)\s*\(\s*` + LOG_PATH_ARG + String.raw`\b`, 'gs');
    return [...text.matchAll(re)].map((m) => m[1]);
  };

  /**
   * A thin wrapper that receives the log path is FINE if it routes to the one writer -- that is
   * what `appendRuntimeLog` in each inbox module is. It is a BYPASS if it does not. So the rule is
   * not a name allowlist (which would bless the evasion by spelling) but a property of the
   * wrapper's own body: whatever receives the path must hand it to `appendRuntimeLogLine`.
   *
   * Deliberately conservative: it reads the few lines after the definition, so a long wrapper
   * fires the control rather than passing. A control that errs should err toward complaining.
   */
  /**
   * Does the function `name` -- wherever it is defined -- hand the path to the one writer?
   *
   * HERCULE FOUND THE FIRST VERSION OF THIS WRONG (Mut-3, 2026-11-04), and the defect is a shape I
   * hit repeatedly: a guard WIDENED to admit a legitimate case without re-drawing its boundary.
   * The legitimate case is an IMPORTED sink -- `appendRuntimeEventToLog` is defined in
   * `runtime-events.ts`, not in its callers -- so I admitted it with a disjunct:
   *
   *     wrapperRoutesToWriter(text, callee) || text.includes('appendRuntimeLogLine')
   *
   * That second clause CLEARS EVERY CALLEE IN ANY FILE THAT USES THE WRITER ANYWHERE. Combined
   * with the write-API control keying on the ARGUMENT name, a renamed parameter escaped both:
   *
   *     function sneaky(p: string, b: string) { fs.appendFileSync(p, b); }
   *     sneaky(runtimeLogPath, prompt);          // in claude-wrapper.ts -- 17/17 STAYED GREEN
   *
   * I reproduced it myself before accepting it: a real body-leaking bypass, naming `runtimeLogPath`
   * at the call site, in an existing file -- so NOT the computed-path residual I had documented.
   * My "a reversion either routes through the formatter or the control fires" was overstated by
   * exactly that shape.
   *
   * The fix is to RESOLVE the callee instead of guessing from the file: check the definition where
   * it actually lives -- locally, or in the module it is imported from.
   */
  /**
   * MY FIRST FIX FOR HERCULE'S Mut-3 WAS DECORATION, and only running his mutation showed it: I
   * read a BOUNDED 400-CHARACTER WINDOW from `function <name>(`, and that window SPILLS INTO THE
   * NEXT FUNCTION. His `sneaky` sits immediately before `logRuntime`, whose body does contain
   * `appendRuntimeLogLine`, so the bypass was cleared by its NEIGHBOUR's body and Mut-3 stayed
   * 17/17 green against the "fix". That is the same shape as the defect it was fixing -- a bounded
   * heuristic whose REACH was wrong -- which is why this now matches braces instead of counting
   * characters: the body of a function is a thing you can find exactly, so guessing at it was
   * never justified.
   */
  const functionBody = (text: string, name: string): string | undefined => {
    const at = text.indexOf(`function ${name}(`);
    if (at === -1) return undefined;
    const open = text.indexOf('{', at);
    if (open === -1) return undefined;
    let depth = 0;
    for (let i = open; i < text.length; i += 1) {
      if (text[i] === '{') depth += 1;
      else if (text[i] === '}') {
        depth -= 1;
        if (depth === 0) return text.slice(open, i + 1);
      }
    }
    return undefined; // unbalanced -> treat as unknown, which the caller reads as "does not route"
  };

  const definitionRoutes = (text: string, name: string): boolean => {
    const body = functionBody(text, name);
    return body === undefined ? false : body.includes('appendRuntimeLogLine');
  };

  /** The module a name is imported from, if it is. */
  const importedFrom = (text: string, name: string): string | undefined => {
    const re = new RegExp(String.raw`import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]`, 'g');
    for (const m of text.matchAll(re)) {
      const names = m[1].split(',').map((n) => n.trim().split(/\s+as\s+/)[0].trim());
      if (names.includes(name)) return m[2];
    }
    return undefined;
  };

  const resolveModule = (fromFile: string, spec: string): string | undefined => {
    if (!spec.startsWith('.')) return undefined;
    const candidate = path.resolve(path.dirname(fromFile), spec.replace(/\.js$/, '.ts'));
    return fs.existsSync(candidate) ? candidate : undefined;
  };

  const calleeRoutesToWriter = (file: string, text: string, callee: string): boolean => {
    if (definitionRoutes(text, callee)) return true;           // defined here and routes
    const spec = importedFrom(text, callee);
    if (!spec) return false;                                   // neither local nor imported
    const mod = resolveModule(file, spec);
    if (!mod) return false;                                    // unresolvable -> complain
    return definitionRoutes(fs.readFileSync(mod, 'utf8'), callee);
  };

  it('the declared exceptions still write DIFFERENT files, which is what licenses excluding them', () => {
    const direct = fs.readFileSync(path.join(SRC, DECLARED_EXCEPTION), 'utf8');
    expect(direct).toContain('discordSendHealthLogPath()');
    expect(direct).not.toContain('runtime-state');
    expect(direct).not.toContain('runtimeLogPath');

    const poller = fs.readFileSync(path.join(SRC, SECOND_EXCEPTION), 'utf8');
    // If this ever becomes a runtime-state log, it stops being exempt and the control must see it.
    expect(poller).not.toContain('runtime-state');
  });

  it('no write API is called with the runtime log path, including across lines', () => {
    const offenders: string[] = [];
    for (const f of files()) {
      const rel = path.relative(SRC, f);
      if (rel === WRITER || rel === DECLARED_EXCEPTION || rel === SECOND_EXCEPTION) continue;
      // Matched over the WHOLE FILE: isla found that a per-line scan could not see
      // `claude-wrapper.ts`'s two multi-line `fs.appendFileSync(` calls, so the control reported a
      // property it was structurally unable to observe, while passing.
      if (WRITE_CALL.test(fs.readFileSync(f, 'utf8'))) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it('anything that RECEIVES the log path routes to the one writer, so an alias cannot bypass it', () => {
    const offenders: string[] = [];
    for (const f of files()) {
      const rel = path.relative(SRC, f);
      if (rel === WRITER || rel === DECLARED_EXCEPTION || rel === SECOND_EXCEPTION) continue;
      const text = fs.readFileSync(f, 'utf8');
      for (const callee of new Set(calleesReceivingLogPath(text))) {
        if (callee === 'appendRuntimeLogLine' || PATH_HELPERS.has(callee)) continue;
        // An imported sink is fine if its own module routes; a local wrapper must route here.
        const routes = calleeRoutesToWriter(f, text, callee);
        if (!routes) offenders.push(`${rel}: ${callee}(`);
      }
    }
    // This is the evasion-resistance half hercule said he would attack: a thin wrapper or an alias
    // around `appendFileSync` still RECEIVES the path, so it surfaces here even though it never
    // names an fs API. A COMPUTED path still escapes -- stated in the block comment above, and the
    // reason acceptance (a) also observes a real file rather than resting on these.
    expect(offenders).toEqual([]);
  });

  it('no injection log line is constructed outside formatInjectionLog', () => {
    const offenders: string[] = [];
    for (const f of files()) {
      const rel = path.relative(SRC, f);
      if (rel === WRITER) continue;
      const text = fs.readFileSync(f, 'utf8');
      // Any template literal that builds an "injecting ..." line is a second formatter.
      const m = text.match(/`injecting [^`]*`/g);
      if (m) offenders.push(`${rel}: ${m.join(' | ')}`);
    }
    // isla: the old control matched only the literal `${prompt}`, so `${prompt.trim()}` or
    // `${message.body}` would have passed it. Forbidding the LINE SHAPE outside the formatter
    // closes the whole family instead of naming one spelling of it.
    expect(offenders).toEqual([]);
  });

  it('every injection site calls the formatter, and there are seven of them', () => {
    let calls = 0;
    for (const f of files()) {
      if (path.relative(SRC, f) === WRITER) continue;
      for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
        if (/formatInjectionLog\(/.test(line)) calls += 1;
      }
    }
    // Hercule treats the count as a claim to check, so it is asserted rather than stated. The
    // method was a grep for runtime-log writes embedding a body variable, then an enumeration --
    // NOT taken from the row, which named one site of the seven.
    expect(calls).toBe(7);
  });
});

describe('formatInjectionLog: the chokepoint itself', () => {
  it('records the length and never the body, whatever the body contains', async () => {
    const { formatInjectionLog } = await loadWriter();
    const prompt = 'rotate SQUAMOUS-PANGOLIN-8821 and also $pipestatus and `backticks`';
    const line = formatInjectionLog('mail', 'msg-9', prompt);

    expect(line).toBe(`injecting mail msg-9: ${prompt.length} chars`);
    expect(line).not.toContain('SQUAMOUS-PANGOLIN-8821');
  });

  it('omits the id for sources that have none, rather than printing undefined', async () => {
    const { formatInjectionLog } = await loadWriter();
    expect(formatInjectionLog('handoff', undefined, 'abc')).toBe('injecting handoff: 3 chars');
    // event-inbox ids are numeric; the signature admits that rather than coercing at one site.
    expect(formatInjectionLog('event-inbox', 41, 'abcd')).toBe('injecting event-inbox 41: 4 chars');
  });
});

describe('the bound tolerates a mistyped knob (isla)', () => {
  it('falls back to the default on a value that is not a usable number', async () => {
    for (const bad of ['8MiB', '', '   ', 'NaN', '-1', '0', '12abc']) {
      const { RUNTIME_LOG_MAX_BYTES } = await loadWriter(undefined, bad);
      // The first version was Math.max(1024, Number(raw)): "8MiB" is NaN, and `size >= NaN` is
      // ALWAYS FALSE, so a typo in the knob this PR advertises silently REMOVED the bound. An
      // empty string gave 1024 and rotated on every line.
      expect(RUNTIME_LOG_MAX_BYTES).toBe(8 * 1024 * 1024);
    }
  });

  it('accepts a valid override, so the fallback has not swallowed the knob', async () => {
    const { RUNTIME_LOG_MAX_BYTES } = await loadWriter(undefined, '4096');
    expect(RUNTIME_LOG_MAX_BYTES).toBe(4096);
  });
});

describe('a persistent rotation failure is reported once, not swallowed and not repeated (isla)', () => {
  it('writes one rotation-failed line and keeps appending', async () => {
    const { appendRuntimeLogLine } = await loadWriter(1024);
    fs.mkdirSync(`${logPath}.1`);
    fs.writeFileSync(path.join(`${logPath}.1`, 'occupied'), 'x');
    fs.writeFileSync(logPath, 'z'.repeat(2048));

    for (let i = 0; i < 5; i += 1) appendRuntimeLogLine(logPath, `FAULT attempt ${i}`);

    const text = fs.readFileSync(logPath, 'utf8');
    const failures = text.split('\n').filter((l) => l.includes('rotation failed:'));
    // Once per process: the bound is lost, and losing it SILENTLY was the defect. A line per
    // append would be the same unbounded growth wearing a diagnostic label.
    expect(failures).toHaveLength(1);
    // And the non-goal still holds -- every signal line got through.
    for (let i = 0; i < 5; i += 1) expect(text).toContain(`FAULT attempt ${i}`);
  });
});
