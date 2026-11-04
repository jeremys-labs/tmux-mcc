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
async function loadWriter(maxBytes?: number) {
  vi.resetModules();
  if (maxBytes !== undefined) vi.stubEnv('RUNTIME_LOG_MAX_BYTES', String(maxBytes));
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
 * STRUCTURAL CONTROLS, AND THEY EXIST BECAUSE OF A LIMIT I CAN STATE PRECISELY: six of the seven
 * body-writing sites live in `claude-wrapper.ts` and `codex-wrapper.ts`, which run module-scope
 * side effects on import (they read argv and the environment and build paths), so no behaviour
 * test in this package can reach them. The acceptance (a) and (c) tests above drive the SEVENTH
 * site, which is the one the row named and the only injectable one.
 *
 * So the other six are pinned the only way they can be: by the source. That is weaker than a
 * behaviour test and stronger than nothing, and it has one property a behaviour test would not
 * have -- IT ALSO CATCHES A SITE SOMEONE ADDS LATER, which is how this defect arrived in the
 * first place (the sibling journal was written to avoid bodies while six wrappers wrote them).
 */
describe('structural controls: the properties behaviour tests cannot reach here', () => {
  const SRC = path.resolve(__dirname, '..');
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
   * THE ONE DECLARED EXCEPTION, AND ITS PRECONDITION IS ASSERTED RATHER THAN TRUSTED.
   * `discord-direct-send.ts` appends to a variable also called `logPath`, but it is a DIFFERENT
   * FILE -- the discord-send health log, not `bridge/runtime-state/<agent>.log`. This control
   * matches by VARIABLE NAME, which cannot distinguish destinations: a predicate over a name
   * standing in for a question about which file. So the exclusion is conditional on that file
   * still resolving its path from `discordSendHealthLogPath()`; repoint it at the runtime log and
   * the next test fails, which is what stops this exception from quietly widening.
   */
  const DECLARED_EXCEPTION = path.join('services', 'discord-direct-send.ts');

  it('the declared exception still writes a DIFFERENT file, which is what licenses excluding it', () => {
    const text = fs.readFileSync(path.join(SRC, DECLARED_EXCEPTION), 'utf8');
    expect(text).toContain('discordSendHealthLogPath()');
    expect(text).not.toContain('runtime-state');
  });

  it('every runtime-log write goes through the ONE writer, so the bound cannot be bypassed', () => {
    const offenders: string[] = [];
    for (const f of files()) {
      if (f.endsWith(path.join('services', 'runtime-log.ts'))) continue; // the writer itself
      if (f.endsWith(DECLARED_EXCEPTION)) continue;                      // asserted above
      const text = fs.readFileSync(f, 'utf8');
      text.split('\n').forEach((line, i) => {
        if (/appendFileSync\(\s*(runtimeLogPath|logPath)\b/.test(line)) {
          offenders.push(`${path.relative(SRC, f)}:${i + 1}`);
        }
      });
    }
    // A raw append would be a write the rotation never sees: the file would grow past the bound
    // for whichever code path used it, and "the log is bounded" would depend on the call site.
    expect(offenders).toEqual([]);
  });

  it('no runtime-log write interpolates a prompt BODY, which pins all seven sites', () => {
    const offenders: string[] = [];
    for (const f of files()) {
      const text = fs.readFileSync(f, 'utf8');
      text.split('\n').forEach((line, i) => {
        const writes = /(appendRuntimeLogLine|appendRuntimeLog|logRuntime|log)\s*\(/.test(line);
        // `${prompt}` but NOT `${prompt.length}` -- the body itself.
        const body = /\$\{\s*prompt\s*\}/.test(line);
        if (writes && body) offenders.push(`${path.relative(SRC, f)}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it('the seven injection sites all report a length, so the fix is complete rather than partial', () => {
    let lengthForm = 0;
    for (const f of files()) {
      for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
        if (/injecting .*\$\{\s*prompt\.length\s*\} chars/.test(line)) lengthForm += 1;
      }
    }
    // Hercule treats the count as a claim to check (dc-20261001-002 row), so it is asserted here
    // rather than only stated in a message. Enumerated by grepping for runtime-log writes that
    // embed a body variable -- NOT taken from the row, which named one site of the seven.
    expect(lengthForm).toBe(7);
  });
});
