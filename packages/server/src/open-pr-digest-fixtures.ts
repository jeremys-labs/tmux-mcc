/**
 * Shared fixtures for the open-PR digest specs (dc-20261125-vitest-worker).
 *
 * EXTRACTED SO THE SPECS CAN BE SPLIT ACROSS TWO FILES, which is the point: ~50 tests of
 * synchronous `spawnSync` git work in ONE worker blocked its event loop long enough that vitest
 * dropped task updates and the whole-file run exited 1 on
 * `[vitest-worker]: Timeout calling "onTaskUpdate"` while reporting every test as passed.
 * Measured: the first 25 tests alone are clean, all 50 are not, and each half of this split is
 * clean. NOT a .test.ts, so vitest does not collect it.
 */
// dc-20261021-001 acceptance. Five criteria, each with the control that discriminates it:
// a case that fires is paired with a case that must NOT, because a flag that fires on
// everything is as broken as one that fires on nothing, and noisier.
//
// The git fixtures are REAL repositories, not stubs. On dc-20261017-001 a control over a
// string-compared path passed while the bug it guarded was reverted, because the fixture could
// not express the difference; real git is what makes "behind", "at main", "detached" and
// "not on main" distinguishable rather than asserted.
//
// REWRITTEN 2026-11-02 after isla's step-3 MUST-CHANGE on head 9a44849 (10 findings, all
// accepted). The old (2a)/(2b) passed because the `gh` stub returned `APPROVED` and
// `CHANGES_REQUESTED` -- VALUES THE REAL `gh` NEVER PRODUCES IN THIS REPO, where
// `reviewDecision` is `""` on all eight PRs sampled including four merged ones. Those controls
// proved the code handled a world that does not exist. They now drive the real verdict source.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SWEEP = path.resolve(here, '../../../scripts/open-pr-digest.mjs');
const RUNNER = path.resolve(here, '../../../scripts/run-open-pr-digest.mjs');
const NOW = '2026-10-30T12:00:00Z';
const HEAD_OID = 'abc1234567890abc1234567890abc1234567890a';
// Sweep and runner agree by default; (7) overrides it to build the stale-artifact case.
const FIXTURE_RUN = 'fixture-run';
const roots: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-digest-flags-'));
  roots.push(dir);
  return dir;
}
/**
 * Registered by each test file as `afterEach(cleanupRoots)`. It lives here so both halves of
 * the split share ONE cleanup, and vitest hooks stay in the files that own the tests.
 */
export function cleanupRoots(): void {
  for (const d of roots.splice(0)) fs.rmSync(d, { recursive: true, force: true });
}

/** A stub `gh` that answers `pr list --repo X` from a fixture, and [] for every other repo. */
let stubSeq = 0;
/**
 * UNIQUELY NAMED PER CALL. With a fixed `gh` name under a shared root, building a second env
 * REWRITES the stub the first env object still points at, so a later sweep silently runs the
 * newer fixture. That cost a false red in (5e): the code was correct and the fixture aliased.
 */
function ghStub(dir: string, byRepo: Record<string, unknown[]>, headDates: Record<string, string> = {}): string {
  const p = path.join(dir, `gh-${(stubSeq += 1)}`);
  // IT ANSWERS BOTH CALLS THE SWEEP MAKES. The head commit date moved off `pr list --json
  // commits` to a REST lookup for the single head sha, because `commits` at --limit 50 put
  // gh's GraphQL query over the 500,000-node limit and took the whole digest down. A stub that
  // answered only `pr list` would have let the grace silently fall back to `createdAt`.
  fs.writeFileSync(p, `#!/usr/bin/env node
const argv = process.argv.slice(2);
const headDates = ${JSON.stringify(headDates)};
if (argv[0] === 'api') {
  const m = /\\/commits\\/([0-9a-f]+)$/.exec(argv[1] || '');
  process.stdout.write(m && headDates[m[1]] ? headDates[m[1]] : '');
  process.exit(0);
}
const i = argv.indexOf('--repo');
const fixtures = ${JSON.stringify(byRepo)};
process.stdout.write(JSON.stringify(fixtures[argv[i + 1]] ?? []));
`);
  fs.chmodSync(p, 0o755);
  return p;
}

function git(cwd: string, args: string[], when?: string) {
  const env = { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t',
                GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t',
                ...(when ? { GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when } : {}) };
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

/**
 * Builds a real origin plus three checkouts.
 *
 * TWO SEPARATE KNOBS, and the separation IS isla's finding 2: `commitAt` is when the missing
 * commit was WRITTEN, `learnedAt` is when this checkout's remote-tracking ref MOVED to include
 * it. A commit authored last week and merged a minute ago leaves a checkout that has had no
 * opportunity to be stale, and the old single-knob fixture could not tell the two apart.
 *
 * The pre-fetch at `learnedAt` is what makes the age deterministic: git stamps reflog entries
 * from GIT_COMMITTER_DATE, and because the fetch already happened the sweep's own fetch finds
 * nothing new and adds no entry at the wall clock.
 */
function makeCheckouts(root: string, commitAt: string, learnedAt = commitAt) {
  const origin = path.join(root, 'origin.git');
  fs.mkdirSync(origin);
  git(origin, ['init', '--bare', '-b', 'main']);
  const seed = path.join(root, 'seed');
  git(root, ['clone', '-q', origin, 'seed']);
  fs.writeFileSync(path.join(seed, 'a'), '1');
  git(seed, ['add', 'a']); git(seed, ['commit', '-qm', 'one'], '2026-10-01T00:00:00Z');
  git(seed, ['push', '-q', 'origin', 'main']);

  const src = path.join(root, 'src');
  fs.mkdirSync(src);
  for (const name of ['agent-supervisor', 'mcc-tmux', 'agent-comms']) {
    git(src, ['clone', '-q', origin, name]);
  }
  fs.writeFileSync(path.join(seed, 'b'), '2');
  git(seed, ['add', 'b']); git(seed, ['commit', '-qm', 'two'], commitAt);
  git(seed, ['push', '-q', 'origin', 'main']);

  // agent-supervisor: BEHIND, having learned of the commit at `learnedAt`.
  git(path.join(src, 'agent-supervisor'), ['fetch', '-q', 'origin'], learnedAt);
  // mcc-tmux: AT MAIN. agent-comms: DETACHED.
  git(path.join(src, 'mcc-tmux'), ['pull', '-q', '--ff-only', 'origin', 'main']);
  const comms = path.join(src, 'agent-comms');
  git(comms, ['pull', '-q', '--ff-only', 'origin', 'main']);
  git(comms, ['checkout', '-q', '--detach', 'HEAD']);
  return src;
}

function roster(dir: string, keys: string[] | null): string {
  const p = path.join(dir, `roster-${(stubSeq += 1)}.json`);
  if (keys === null) fs.writeFileSync(p, 'not json');
  else fs.writeFileSync(p, JSON.stringify({ agents: keys.map((k) => ({ key: k, state: 'active' })) }));
  return p;
}

/** A verdict comment of the shape the digest now keys on. */
function verdict(sha: string, decision = 'MUST-CHANGE', createdAt = '2026-10-26T09:00:00Z') {
  return { body: `VERDICT: ${decision} @ ${sha}\n\nsome review prose`, createdAt };
}
/** Any other comment. The author's dispositions are the real newest-comment case. */
function comment(body: string, createdAt: string) {
  return { body, createdAt };
}

function pr(over: Record<string, unknown> = {}) {
  return {
    number: 36, title: 'a pr', body: '', createdAt: '2026-10-25T12:00:00Z',
    updatedAt: '2026-10-29T12:00:00Z', reviewDecision: '', isDraft: false,
    reviewRequests: [], assignees: [], files: [], headRefName: 'marcus/thing',
    headRefOid: HEAD_OID,
    comments: [],
    ...over,
  };
}

function sweep(env: Record<string, string>) {
  const r = spawnSync('node', [SWEEP], { encoding: 'utf8', env: { ...process.env, ...env } });
  return { ...r, findings: env.OPEN_PR_DIGEST_FINDINGS_PATH && fs.existsSync(env.OPEN_PR_DIGEST_FINDINGS_PATH)
    ? JSON.parse(fs.readFileSync(env.OPEN_PR_DIGEST_FINDINGS_PATH, 'utf8')) : null };
}

const DEFAULT_HEAD_DATES: Record<string, string> = { [HEAD_OID]: '2026-10-25T12:00:00Z' };

function baseEnv(root: string, prs: Record<string, unknown[]>, srcRoot: string,
                 rosterKeys: string[] | null = ['marcus', 'eli', 'isla'],
                 headDates: Record<string, string> = DEFAULT_HEAD_DATES) {
  return {
    OPEN_PR_DIGEST_GH_BIN: ghStub(root, prs, headDates),
    OPEN_PR_DIGEST_CHECKOUT_ROOT: srcRoot,
    OPEN_PR_DIGEST_FINDINGS_PATH: path.join(root, 'findings.json'),
    OPEN_PR_DIGEST_ROSTER: roster(root, rosterKeys),
    OPEN_PR_DIGEST_NOW: NOW,
    OPEN_PR_DIGEST_RUN_ID: FIXTURE_RUN,
  };
}

/** A mail binary that logs every invocation, so "who was told" is observable. */
function mailStub(root: string, log: string, failFor?: string): string {
  const p = path.join(root, `agent-mail-${(stubSeq += 1)}`);
  // IT REFUSES WITHOUT AGENT_MAIL_DIR, EXACTLY AS THE REAL BINARY DOES. Verified against the
  // real agent-mail: with it, exit 0 and a message id; without it, exit 1 and
  // "AGENT_MAIL_DIR is not set. Refusing to fall back to ...". My previous stub needed no such
  // variable, so it worked in a world the real tool refuses -- and the runner never set it, so
  // the routing leg could not deliver from the only place it actually runs. Same shape as the
  // `gh` stub that returned APPROVED: a stub that is easier to satisfy than its subject.
  fs.writeFileSync(p, `#!/usr/bin/env node
const argv = process.argv.slice(2);
if (!process.env.AGENT_MAIL_DIR) {
  process.stderr.write('AGENT_MAIL_DIR is not set. Refusing to fall back.\\n');
  process.exit(1);
}
require('fs').appendFileSync(${JSON.stringify(log)}, argv.join(' ') + '\\n');
// THE BODY IS RECORDED TOO, in its own file so every existing assertion on the argv log keeps
// measuring exactly what it measured before. Repointing a shared helper changes every caller's
// meaning at once, and the callers that still pass are the dangerous half.
//
// This seam is why isla's finding existed at all: my controls asserted WHO was mailed and never
// WHAT THE MAIL SAID, so a body reading "no review verdict for 217h" over a PR with several
// verdicts, beside a subject saying 0h, was invisible to 31 green tests. Same defect as #36's
// "the runtime was undefined": the plan was asserted, the string never was.
const bf = argv[argv.indexOf('--body-file') + 1];
if (bf) require('fs').appendFileSync(${JSON.stringify(log)} + '.bodies',
  '=== ' + argv.join(' ') + '\\n' + require('fs').readFileSync(bf, 'utf8') + '\\n');
const failFor = ${JSON.stringify(failFor ?? null)};
if (failFor && argv.includes(failFor)) process.exit(1);
`);
  fs.chmodSync(p, 0o755);
  return p;
}

/**
 * A delivery stub standing in for the Discord bridge.
 *
 * THIS SEAM IS WHY FINDING 3 EXISTED. Without it the only way a test could reach the routing
 * leg was `--dry-run`, because delivery shells out to the real bridge -- so `--dry-run` grew a
 * routing side effect and my own test (5) asserted mail WAS sent under it, pinning the defect
 * as intended behaviour. The missing seam caused the bug, not just the gap in the control.
 */
function deliverStub(root: string): string {
  const p = path.join(root, `deliver-${(stubSeq += 1)}`);
  fs.writeFileSync(p, '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ ok: true, id: "stub" }));\n');
  fs.chmodSync(p, 0o755);
  return p;
}

function runnerEnv(root: string, findingsPath: string, over: Record<string, string> = {}) {
  fs.writeFileSync(path.join(root, 'noop.mjs'), 'console.log("x");');
  return {
    ...process.env,
    OPEN_PR_DIGEST_SCRIPT: path.join(root, 'noop.mjs'),
    OPEN_PR_DIGEST_STATUS_PATH: path.join(root, 'status.json'),
    OPEN_PR_DIGEST_FINDINGS_PATH: findingsPath,
    OPEN_PR_DIGEST_NOTIFIED_PATH: path.join(root, 'notified.json'),
    OPEN_PR_DIGEST_DELIVER_BIN: deliverStub(root),
    OPEN_PR_DIGEST_AGENT: 'marcus',
    OPEN_PR_DIGEST_RUN_ID: FIXTURE_RUN,
    ...over,
  } as Record<string, string>;
}

/**
 * THE RUNNER'S EXIT STATUS IS ASSERTED, NEVER DISCARDED (dc-20261125-vitest-worker).
 *
 * There were 26 call sites and exactly ONE captured the result. So a runner that died left the
 * test asserting against an empty mail log, and `(15b)` failed with
 * `expected '' to contain 'it is for an OLDER head'` -- which reads as "the mail had the wrong
 * words" when the truth may be "no runner ran at all". The fixture was strict about git (see
 * `git()`, which throws on non-zero) and silent about the runner. Absence of a reason is not a
 * reason, which is the defect this whole file exists to pin, reproduced in its own fixture.
 *
 * `expectStatus` is an ASSERTION, not an opt-out: a caller that accepts any status is the same
 * blind spot moved three lines down (isla). Pass the exact code you expect. The runner exits
 * `status === 'ok' ? 0 : 1` (run-open-pr-digest.mjs:347), so 0 or 1 are the only valid values.
 */
function runRunner(env: Record<string, string>, args: string[] = [],
                   { expectStatus = 0 }: { expectStatus?: 0 | 1 } = {}) {
  const r = spawnSync('node', [RUNNER, ...args], { encoding: 'utf8', env });
  if (r.status !== expectStatus) {
    // AND THE STATUS FILE: the runner exits 1 for `status !== 'ok'` with NOTHING on stderr, so
    // the code alone says "it decided something was wrong", not WHAT. `reason` is the field that
    // names it -- `routing_failed`, `findings_unavailable` -- and without it this error sends the
    // reader back to guessing, which is the whole defect being fixed.
    const statusFile = env.OPEN_PR_DIGEST_STATUS_PATH;
    let state = statusFile ? '<unreadable>' : '<no OPEN_PR_DIGEST_STATUS_PATH in env>';
    if (statusFile) {
      try { state = fs.readFileSync(statusFile, 'utf8'); } catch (e) { state = `<unreadable: ${String(e)}>`; }
    }
    throw new Error(
      `runner exited ${r.status} (expected ${expectStatus}), signal=${r.signal}\n`
      + `--- runner stderr ---\n${r.stderr ?? ''}\n--- runner stdout ---\n${r.stdout ?? ''}\n`
      + `--- status.json ---\n${state}`,
    );
  }
  return r;
}
/**
 * For the scenarios whose whole POINT is a failing run -- a stale or missing artifact, a dead
 * mail binary, a send that fails. Measured per call site rather than assumed: the runner exits
 * `status === 'ok' ? 0 : 1`, so these are exactly 1, and asserting 1 keeps the `expectStatus`
 * contract an assertion instead of an opt-out (isla).
 */
function runRunnerExpectFail(env: Record<string, string>, args: string[] = []) {
  return runRunner(env, args, { expectStatus: 1 });
}

/**
 * status.json IS VALIDATED, because reading it blind is the other half of the same blind spot.
 * A flaky run produced `Cannot read properties of undefined (reading 'recipients')` -- the
 * runner had written an incomplete file and the test reported a property access instead of the
 * real fault. Name what is missing and show the file.
 */
function status(root: string) {
  const file = path.join(root, 'status.json');
  const raw = fs.readFileSync(file, 'utf8');
  const parsed = JSON.parse(raw);
  for (const key of ['status', 'routing'] as const) {
    if (parsed[key] === undefined) {
      throw new Error(`status.json has no \`${key}\`; the runner wrote an incomplete file.\n${raw}`);
    }
  }
  return parsed;
}

function mailLines(log: string): string[] {
  return fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [];
}
/** Every mail's argv AND body, so the TEXT is assertable and not just the recipient list. */
function mailBodies(log: string): string {
  const p = `${log}.bodies`;
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
}


export {
  SWEEP,
  RUNNER,
  NOW,
  HEAD_OID,
  FIXTURE_RUN,
  DEFAULT_HEAD_DATES,
  tempDir,
  ghStub,
  git,
  makeCheckouts,
  roster,
  verdict,
  comment,
  pr,
  sweep,
  baseEnv,
  mailStub,
  deliverStub,
  runnerEnv,
  runRunner,
  runRunnerExpectFail,
  status,
  mailLines,
  mailBodies,
};
