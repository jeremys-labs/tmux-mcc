import { afterEach, describe, expect, it } from 'vitest';
import { spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * ACCEPTANCE (a) OF dc-20261001-002, OBSERVED ON THE REAL LOG FILE.
 *
 * WHY THIS EXISTS AND WHY THE OTHER TESTS ARE NOT ENOUGH (hercule): the row says the injected
 * string must be absent FROM THE LOG. A test on `formatInjectionLog` proves the FORMATTER is safe;
 * a source control proves every site ROUTES through it. Neither observes the file. "A source-pinned
 * control that cannot observe the real log is weaker for a DISCLOSURE property than for a behaviour
 * one" -- his words, and he is right.
 *
 * So this runs the REAL `claude-wrapper.ts` as a subprocess against a temp content root and reads
 * the real `bridge/runtime-state/<agent>.log` that the wrapper itself writes.
 *
 * NO PRODUCTION SEAM IS NEEDED, and that was isla's call rather than my first instinct: I was about
 * to add a `CLAUDE_WRAPPER_BINARY` env override because `pty.spawn('claude', ...)` looked
 * hardcoded. She pointed out it is a BARE NAME, so PATH resolution already provides the seam --
 * a stub `claude` earlier on PATH is picked up with the production line untouched. Tested, and it
 * works. The default stays `claude`.
 *
 * THE PAIR IS WHAT MAKES THIS NON-VACUOUS, which is hercule's condition and the reason this file is
 * shaped this way. A harness that never fires an injection satisfies "the string is absent" FOR THE
 * WRONG REASON, and that shares a failure mode with the property under test. So the assertion is
 * not merely "absent": it REQUIRES the `injecting handoff: <n> chars` line to be present first.
 * Measured on this harness, with the one line reverted to its pre-fix form:
 *
 *     pre-fix   ->  "injecting handoff: [Runtime Handoff]..."   string present (count 1)
 *     post-fix  ->  "injecting handoff: 275 chars"              string absent  (count 0)
 *
 * The pre-fix half is carried as a mutation rather than a second test, because asserting it would
 * mean shipping the defect. The mutation battery reverts exactly that line and this test goes red.
 *
 * MY OWN HARNESS DEFECT, RECORDED BECAUSE IT NEARLY BECAME A FINDING ABOUT THE CODE: my first
 * attempt passed `--cwd`, and the wrapper's flag is `--cd`. The unknown flag was FORWARDED to the
 * runtime's argv and the workspace silently fell back to `process.cwd()`, where there is no handoff
 * file -- so the injection returned 'empty' and no line was ever written. I spent a while reading
 * the poller and the task queue for a defect that was in my own invocation.
 */

const REPO_SERVER = path.resolve(__dirname, '..', '..');
const DISTINCTIVE = 'SQUAMOUS-PANGOLIN-8821';

let child: ChildProcess | undefined;
let dir: string | undefined;

afterEach(() => {
  child?.kill('SIGTERM');
  child = undefined;
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

const waitFor = async (predicate: () => boolean, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
};

describe('acceptance (a) end-to-end: the real wrapper, the real log file', () => {
  it('writes the injection line with a length and the body never reaches the file', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-log-e2e-'));
    const workspace = path.join(dir, 'ws');
    const contentRoot = path.join(dir, 'content');
    const binDir = path.join(dir, 'bin');
    for (const d of [workspace, contentRoot, binDir]) fs.mkdirSync(d, { recursive: true });

    // A stub `claude` earlier on PATH. The production spawn line is untouched.
    const stub = path.join(binDir, 'claude');
    fs.writeFileSync(stub, '#!/bin/sh\nwhile :; do sleep 1; done\n');
    fs.chmodSync(stub, 0o755);

    // The distinctive string goes in next_step_notes, which reaches the injectable text -- the
    // free-text field most likely to carry something sensitive in real use.
    const handoff = {
      schema_version: 1,
      agent: 'e2e',
      from_runtime: 'codex',
      to_runtime: 'claude',
      reason: 'acceptance (a) end-to-end',
      ts: new Date().toISOString(),
      workspace,
      pending_mail_count: 0,
      pending_inbox_count: 0,
      next_step_notes: `rotate ${DISTINCTIVE} before Friday`,
    };
    fs.writeFileSync(
      path.join(workspace, '.runtime-handoff.md'),
      `# Runtime Handoff\n\n\`\`\`json\n${JSON.stringify(handoff, null, 2)}\n\`\`\`\n`
    );

    child = spawn('npx', ['tsx', 'src/claude-wrapper.ts', '--agent', 'e2e', '--cd', workspace], {
      cwd: REPO_SERVER,
      env: {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
        CONTENT_ROOT: contentRoot,
        CLAUDE_WRAPPER_HANDOFF_SUBMIT_DELAY_MS: '100',
      },
      stdio: 'ignore',
    });

    const logPath = path.join(contentRoot, 'bridge', 'runtime-state', 'e2e.log');
    const read = (): string => {
      try {
        return fs.readFileSync(logPath, 'utf8');
      } catch {
        return '';
      }
    };

    const fired = await waitFor(() => /injecting handoff:/.test(read()), 60_000);

    // THE POSITIVE HALF FIRST, deliberately: if the injection never fired, "the string is absent"
    // is true for the wrong reason. A missing line is CANNOT-DETERMINE, not a pass, so this
    // assertion must fail loudly rather than let the absence read as success.
    expect(fired, 'no "injecting handoff" line appeared, so the absence below proves nothing').toBe(true);

    const text = read();
    expect(text).toMatch(/injecting handoff: \d+ chars/);
    expect(text).not.toContain(DISTINCTIVE);
  }, 90_000);
});
