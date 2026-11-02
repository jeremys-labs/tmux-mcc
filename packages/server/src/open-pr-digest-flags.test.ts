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
import { afterEach, describe, expect, it } from 'vitest';

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
afterEach(() => {
  for (const d of roots.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** A stub `gh` that answers `pr list --repo X` from a fixture, and [] for every other repo. */
let stubSeq = 0;
/**
 * UNIQUELY NAMED PER CALL. With a fixed `gh` name under a shared root, building a second env
 * REWRITES the stub the first env object still points at, so a later sweep silently runs the
 * newer fixture. That cost a false red in (5e): the code was correct and the fixture aliased.
 */
function ghStub(dir: string, byRepo: Record<string, unknown[]>): string {
  const p = path.join(dir, `gh-${(stubSeq += 1)}`);
  fs.writeFileSync(p, `#!/usr/bin/env node
const argv = process.argv.slice(2);
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
    // The head's own commit date is the grace basis, so it defaults to the PR's creation.
    commits: [{ committedDate: '2026-10-25T12:00:00Z' }],
    ...over,
  };
}

function sweep(env: Record<string, string>) {
  const r = spawnSync('node', [SWEEP], { encoding: 'utf8', env: { ...process.env, ...env } });
  return { ...r, findings: env.OPEN_PR_DIGEST_FINDINGS_PATH && fs.existsSync(env.OPEN_PR_DIGEST_FINDINGS_PATH)
    ? JSON.parse(fs.readFileSync(env.OPEN_PR_DIGEST_FINDINGS_PATH, 'utf8')) : null };
}

function baseEnv(root: string, prs: Record<string, unknown[]>, srcRoot: string, rosterKeys: string[] | null = ['marcus', 'eli', 'isla']) {
  return {
    OPEN_PR_DIGEST_GH_BIN: ghStub(root, prs),
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
  fs.writeFileSync(p, `#!/usr/bin/env node
const argv = process.argv.slice(2);
require('fs').appendFileSync(${JSON.stringify(log)}, argv.join(' ') + '\\n');
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

function runRunner(env: Record<string, string>, args: string[] = []) {
  return spawnSync('node', [RUNNER, ...args], { encoding: 'utf8', env });
}
function status(root: string) {
  return JSON.parse(fs.readFileSync(path.join(root, 'status.json'), 'utf8'));
}
function mailLines(log: string): string[] {
  return fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [];
}

describe('dc-20261021-001 — open-PR digest flags', () => {
  it('(1) fires on an agent-repo PR with NO verdict comment past 24h', () => {
    const root = tempDir();
    const src = makeCheckouts(root, '2026-10-29T18:00:00Z'); // behind 18h: under grace
    const r = sweep(baseEnv(root, { 'jeremys-labs/tmux-mcc': [pr()] }, src));
    expect(r.stdout).toContain('No review verdict after 24h');
    expect(r.stdout).toContain('tmux-mcc #36');
    expect(r.findings.undispositioned).toHaveLength(1);
    expect(r.findings.undispositioned[0].verdict).toBe('missing');
  });

  it('(1b) a verdict for an OLDER head is a DISTINCT finding, not "nobody looked"', () => {
    // isla's addition inside her own design: the two tell the author different things -- go get
    // a re-review of the new head, versus nobody has looked at this at all. Collapsing them
    // sends the author to the wrong action.
    const root = tempDir();
    const src = makeCheckouts(root, '2026-10-29T18:00:00Z');
    const old = 'f'.repeat(40);
    const r = sweep(baseEnv(root, { 'jeremys-labs/tmux-mcc': [pr({ comments: [verdict(old)] })] }, src));
    expect(r.findings.undispositioned[0].verdict).toBe('stale');
    expect(r.stdout).toContain('Verdict is for an OLDER head');
    expect(r.stdout).not.toContain('No review verdict after 24h');
  });

  it('(1c) FAILS CLOSED on a sha that is not the head: the PR stays flagged', () => {
    // I typed a wrong sha four times in one day. The unsafe direction -- marking a PR
    // dispositioned when it is not -- would need a sha that happens to equal the head.
    const root = tempDir();
    const src = makeCheckouts(root, '2026-10-29T18:00:00Z');
    const r = sweep(baseEnv(root, { 'jeremys-labs/tmux-mcc': [pr({ comments: [verdict('deadbeef')] })] }, src));
    expect(r.findings.undispositioned).toHaveLength(1);
    expect(r.findings.undispositioned[0].verdict).toBe('stale');
  });

  // SPLIT INTO ONE TEST PER PROPERTY. As a single table-driven test these cases shared ONE
  // control: mutating away the 24h grace, the agent-repo scope, or the draft exclusion all
  // turned the SAME test red, so no one of them was individually pinned and deleting a row
  // from the table would have silently retired a property.
  const noFire = (over: Record<string, unknown>, repo = 'jeremys-labs/tmux-mcc') => {
    const root = tempDir();
    const src = makeCheckouts(root, '2026-10-29T18:00:00Z');
    return sweep(baseEnv(root, { [repo]: [pr(over)] }, src));
  };

  it('(2a) a VERDICT comment naming the current head does not fire', () => {
    const r = noFire({ comments: [verdict(HEAD_OID)] });
    expect(r.findings.undispositioned).toHaveLength(0);
    expect(r.stdout).not.toContain('No review verdict');
  });

  it('(2b) MUST-CHANGE is as much a verdict as APPROVE and does not fire', () => {
    // The flag is "has anyone rendered a verdict", not "was it favourable". A PR with an
    // accepted must-change is reviewed; what it is waiting on is the author.
    expect(noFire({ comments: [verdict(HEAD_OID, 'APPROVE')] }).findings.undispositioned).toHaveLength(0);
    expect(noFire({ comments: [verdict(HEAD_OID, 'MUST-CHANGE')] }).findings.undispositioned).toHaveLength(0);
  });

  it('(2f) THE NEWEST COMMENT IS NOT THE VERDICT — matched by first line, from the real corpus', () => {
    // CAPTURED FROM LIVE #42, and an invented fixture would have hidden it: the newest comment
    // is the AUTHOR'S DISPOSITIONS, which is not a verdict and carries no sha. Taking the
    // newest comment would read it as the verdict, find no sha, and leave the PR PERMANENTLY
    // unmatched -- flagged forever with a verdict sitting right there.
    const r = noFire({ comments: [
      comment('<!-- codex-pull-request-review-summary -->\nsome bot summary', '2026-10-26T08:00:00Z'),
      verdict(HEAD_OID, 'MUST-CHANGE', '2026-10-26T09:00:00Z'),
      comment('## Dispositions — 10 of 10 accepted, none declined', '2026-10-26T10:00:00Z'),
    ] });
    expect(r.findings.undispositioned).toHaveLength(0);
  });

  it('(2g) the NEWEST verdict wins when several name different heads', () => {
    const r = noFire({ comments: [
      verdict(HEAD_OID, 'MUST-CHANGE', '2026-10-26T09:00:00Z'),
      verdict('b'.repeat(40), 'APPROVE', '2026-10-27T09:00:00Z'),
    ] });
    // newest names a non-head sha, so the PR is NOT dispositioned on the current head
    expect(r.findings.undispositioned[0].verdict).toBe('stale');
  });

  it('(2c) a DRAFT is not asking for review yet and does not fire', () => {
    expect(noFire({ isDraft: true }).findings.undispositioned).toHaveLength(0);
  });

  it('(2d) a head pushed only 2h ago is under the grace and does not fire', () => {
    expect(noFire({ commits: [{ committedDate: '2026-10-30T10:00:00Z' }] })
      .findings.undispositioned).toHaveLength(0);
  });

  it('(2h) THE GRACE RUNS FROM THE HEAD, NOT FROM createdAt', () => {
    // isla's finding 8. Once the verdict is per-head, a grace measured from PR creation lets a
    // PR re-pushed an hour ago skip the grace on its NEW head: it is already "5 days old", so
    // the new head is flagged before anyone could have looked at it.
    const r = noFire({
      createdAt: '2026-10-25T12:00:00Z',                         // 120h old PR
      commits: [{ committedDate: '2026-10-30T10:00:00Z' }],      // head pushed 2h ago
    });
    expect(r.findings.undispositioned).toHaveLength(0);
  });

  it('(2e) SCOPE: an ancient unreviewed non-agent-repo PR does not fire', () => {
    const r = noFire({ createdAt: '2026-01-01T00:00:00Z', commits: [{ committedDate: '2026-01-01T00:00:00Z' }] },
                     'jeremys-labs/str-ops');
    expect(r.findings.undispositioned).toHaveLength(0);
  });

  it('(10) ONE CLOCK: the injected NOW moves ageDays and stale, not just the new flags', () => {
    // isla's finding 10. daysSince() used Date.now() while hoursSince() used the injectable
    // NOW, so OPEN_PR_DIGEST_NOW moved the new flags and left `stale`, `ageDays` and the
    // header's flagged count on the wall clock -- two clocks in one digest.
    const root = tempDir();
    const src = makeCheckouts(root, '2026-10-29T18:00:00Z');
    const r = sweep(baseEnv(root, { 'jeremys-labs/str-ops': [pr({
      createdAt: '2026-10-25T12:00:00Z', updatedAt: '2026-10-24T12:00:00Z',
    })] }, src));
    // 5 days against the injected clock. Against the wall clock it is 8+ and would read stale.
    expect(r.stdout).toContain('· 5d ·');
    expect(r.stdout).toContain('0 flagged');
  });

  it('(3) flags a checkout behind origin/main past 24h and not one at main', () => {
    const root = tempDir();
    const src = makeCheckouts(root, '2026-10-28T00:00:00Z'); // learned 60h ago
    const r = sweep(baseEnv(root, {}, src));
    const by = Object.fromEntries(r.findings.drifts.map((d: any) => [d.repo, d]));
    expect(by['agent-supervisor'].state).toBe('behind');
    expect(by['agent-supervisor'].overGrace).toBe(true);
    expect(by['agent-supervisor'].hoursBehind).toBe(60);
    // KEYED ON THE GITHUB REPO NAME, which is `tmux-mcc` while the DIRECTORY is `mcc-tmux`.
    expect(by['tmux-mcc'].state).toBe('at-main');      // the control
    expect(by['tmux-mcc'].dir.endsWith('/mcc-tmux')).toBe(true);
  });

  it('(3b) a checkout behind by LESS than 24h is reported but not over grace', () => {
    const root = tempDir();
    const src = makeCheckouts(root, '2026-10-30T00:00:00Z'); // 12h
    const r = sweep(baseEnv(root, {}, src));
    const sup = r.findings.drifts.find((d: any) => d.repo === 'agent-supervisor');
    expect(sup.state).toBe('behind');
    expect(sup.overGrace).toBe(false);
    expect(sup.hoursBehind).toBe(12);
  });

  it('(3c) a DETACHED head is its own state, neither at-main nor behind', () => {
    const root = tempDir();
    const src = makeCheckouts(root, '2026-10-28T00:00:00Z');
    const r = sweep(baseEnv(root, {}, src));
    const comms = r.findings.drifts.find((d: any) => d.repo === 'agent-comms');
    expect(comms.state).toBe('detached');
    expect(comms.state).not.toBe('at-main');
    expect(comms.state).not.toBe('behind');
    expect(r.stdout).toContain('DETACHED');
  });

  it('(3d) NOT-ON-MAIN is its own state: a branch at main’s tip is not at-main', () => {
    // isla's finding 6. `branch` was captured and used only for null-versus-not, so a checkout
    // on `marcus/foo` rebased onto main counted 0 commits behind and reported `at-main` WHILE
    // RUNNING UNMERGED CODE -- the false reading `detached` exists to prevent, one step along.
    const root = tempDir();
    const src = makeCheckouts(root, '2026-10-28T00:00:00Z');
    git(path.join(src, 'mcc-tmux'), ['checkout', '-q', '-b', 'marcus/foo']);
    const r = sweep(baseEnv(root, {}, src));
    const mcc = r.findings.drifts.find((d: any) => d.repo === 'tmux-mcc');
    expect(mcc.state).toBe('not-on-main');
    expect(mcc.state).not.toBe('at-main');
    expect(mcc.behindCount).toBe(0);          // level with main, and still not on it
    expect(r.stdout).toContain('NOT main');
  });

  it('(3e) DRIFT AGE IS WHEN origin/main MOVED, NOT WHEN THE COMMIT WAS WRITTEN', () => {
    // isla's finding 2, and the discriminating pair: the commit was written 240h ago but this
    // checkout only learned of it 6h ago. Under the commit-date basis this reads 240h and over
    // grace; the honest answer is 6h and under grace, because the checkout has had six hours
    // to pull. A commit authored last week and merged a minute ago is not a week of drift.
    const root = tempDir();
    const src = makeCheckouts(root, '2026-10-20T12:00:00Z', '2026-10-30T06:00:00Z');
    const r = sweep(baseEnv(root, {}, src));
    const sup = r.findings.drifts.find((d: any) => d.repo === 'agent-supervisor');
    expect(sup.ageBasis).toBe('origin-moved');
    expect(sup.hoursBehind).toBe(6);
    expect(sup.overGrace).toBe(false);
  });

  it('(3f) with no reflog for the remote ref it falls back to the commit date AND SAYS SO', () => {
    // A measurement whose basis is unstated is the defect this flag exists to remove, so the
    // fallback is reported rather than silently chosen.
    const root = tempDir();
    const src = makeCheckouts(root, '2026-10-28T00:00:00Z');
    fs.rmSync(path.join(src, 'agent-supervisor', '.git', 'logs', 'refs', 'remotes', 'origin', 'main'),
              { force: true });
    const r = sweep(baseEnv(root, {}, src));
    const sup = r.findings.drifts.find((d: any) => d.repo === 'agent-supervisor');
    expect(sup.ageBasis).toBe('commit-date');
    expect(sup.hoursBehind).toBe(60);
    expect(sup.detail).toContain('basis: commit-date');
  });

  it('(4) an unreadable git yields cannot-determine, never clean', () => {
    const root = tempDir();
    const src = makeCheckouts(root, '2026-10-28T00:00:00Z');
    const brokenGit = path.join(root, 'git-broken');
    fs.writeFileSync(brokenGit, '#!/bin/sh\nexit 3\n');
    fs.chmodSync(brokenGit, 0o755);
    const r = sweep({ ...baseEnv(root, {}, src), OPEN_PR_DIGEST_GIT_BIN: brokenGit });
    for (const d of r.findings.drifts) {
      expect(d.state).toBe('cannot-determine');
      expect(d.state).not.toBe('at-main');
    }
    expect(r.stdout).toContain('cannot-determine');
    expect(r.findings.driftStatus).toBe('problems');   // the unanswerable check is not healthy
  });

  it('(4b) an absent checkout directory is cannot-determine, not at-main', () => {
    const root = tempDir();
    const r = sweep(baseEnv(root, {}, path.join(root, 'nope')));
    expect(r.findings.drifts.every((d: any) => d.state === 'cannot-determine')).toBe(true);
    expect(r.findings.driftStatus).toBe('problems');
  });

  it('(4c) DRIFT DOES NOT SET THE EXIT CODE, it sets driftStatus', () => {
    // isla's finding 5. Acceptance (4) -- drift never reads as clean -- is right, and my
    // implementation of it was wrong: the exit code was ALREADY claimed by "did the job run",
    // so a fact about a REPO rendered as THE JOB BREAKING. Worse, a persistently detached
    // checkout would have pinned the exit at 1 forever and MASKED every real sweep failure.
    const root = tempDir();
    const src = makeCheckouts(root, '2026-10-28T00:00:00Z');   // behind over grace + detached
    const r = sweep(baseEnv(root, {}, src));
    expect(r.findings.driftStatus).toBe('problems');
    expect(r.findings.driftProblems.length).toBeGreaterThan(0);
    expect(r.status).toBe(0);                                   // the sweep RAN
    expect(r.stdout).toContain('Live deploy sources');          // and it is still visible
  });

  it('(4d) a sweep failure DOES set the exit code', () => {
    // The control for (4c): the exit code still means something.
    const root = tempDir();
    const src = makeCheckouts(root, '2026-10-29T18:00:00Z');
    const brokenGh = path.join(root, 'gh-broken');
    fs.writeFileSync(brokenGh, '#!/bin/sh\nexit 4\n');
    fs.chmodSync(brokenGh, 0o755);
    const r = sweep({ ...baseEnv(root, {}, src), OPEN_PR_DIGEST_GH_BIN: brokenGh });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('sweep failures');
  });

  it('(5) the finding reaches the AUTHOR and the operator, once, and only on delivery', () => {
    const root = tempDir();
    const src = makeCheckouts(root, '2026-10-29T18:00:00Z');
    const env = baseEnv(root, { 'jeremys-labs/tmux-mcc': [pr()] }, src);
    sweep(env);
    const log = path.join(root, 'mail.log');
    const renv = runnerEnv(root, env.OPEN_PR_DIGEST_FINDINGS_PATH, {
      OPEN_PR_DIGEST_MAIL_BIN: mailStub(root, log),
    });

    runRunner(renv);
    const sent = mailLines(log).join('\n');
    // THE POINT OF THE ROW: the author, not only the reader of the digest.
    expect(sent).toContain('--to marcus');
    expect(sent).toContain('--to isla');
    expect(mailLines(log)).toHaveLength(2);

    // TRANSITION-ONLY: a second run tells nobody again.
    runRunner(renv);
    expect(mailLines(log)).toHaveLength(2);
    expect(Object.keys(JSON.parse(fs.readFileSync(path.join(root, 'notified.json'), 'utf8'))))
      .toEqual(['tmux-mcc#36']);
  });

  it('(6) --dry-run SENDS NOTHING AND WRITES NO STATE', () => {
    // isla's finding 3. --dry-run skipped Discord and then sent REAL agent-mail and wrote
    // notified.json, so a rehearsal mailed people AND recorded them as told, which SUPPRESSES
    // the real notification on the next run. My own test (5) asserted mail WAS sent under
    // --dry-run, so the control pinned the defect in place as intended behaviour.
    const root = tempDir();
    const src = makeCheckouts(root, '2026-10-29T18:00:00Z');
    const env = baseEnv(root, { 'jeremys-labs/tmux-mcc': [pr()] }, src);
    sweep(env);
    const log = path.join(root, 'mail.log');
    const renv = runnerEnv(root, env.OPEN_PR_DIGEST_FINDINGS_PATH, {
      OPEN_PR_DIGEST_MAIL_BIN: mailStub(root, log),
    });

    runRunner(renv, ['--dry-run']);
    expect(mailLines(log)).toHaveLength(0);
    expect(fs.existsSync(path.join(root, 'notified.json'))).toBe(false);
    expect(status(root).routing.skipped).toContain('dry-run');

    // AND THE REAL RUN STILL TELLS THEM: the rehearsal must not have consumed the transition.
    runRunner(renv);
    expect(mailLines(log)).toHaveLength(2);
  });

  it('(7) findings from ANOTHER run are not routed', () => {
    // isla's finding 7. A sweep that crashed before writing leaves YESTERDAY's findings on
    // disk; routing those mails authors about PRs nobody looked at today and trims the
    // notified state against them. An exact run-id match, not a freshness window.
    const root = tempDir();
    const src = makeCheckouts(root, '2026-10-29T18:00:00Z');
    const env = baseEnv(root, { 'jeremys-labs/tmux-mcc': [pr()] }, src);
    env.OPEN_PR_DIGEST_RUN_ID = 'yesterday';     // the artifact is from an EARLIER run
    sweep(env);
    const log = path.join(root, 'mail.log');
    // The runner's own sweep is a no-op script, so the artifact keeps `yesterday`.
    const renv = runnerEnv(root, env.OPEN_PR_DIGEST_FINDINGS_PATH, {
      OPEN_PR_DIGEST_MAIL_BIN: mailStub(root, log),
    });
    runRunner(renv);
    expect(mailLines(log)).toHaveLength(0);
    expect(status(root).routing.skipped).toContain('another run');
    expect(status(root).findingsFresh).toBe(false);
  });

  it('(8) notified state for a repo that FAILED to sweep is not trimmed', () => {
    // isla's finding 4. The intersection bounds the state against its subject, but intersecting
    // against a repo that failed to sweep erases the record for PRs nobody looked at -- and the
    // author is then re-mailed about a PR they were already told about. Same class as the
    // empty-dir guard in surface-check-journal.py, which I documented and then did not apply.
    const root = tempDir();
    const findings = path.join(root, 'findings.json');
    fs.writeFileSync(findings, JSON.stringify({
      runId: 'fixed-run', undispositioned: [], drifts: [],
      sweptRepos: ['tmux-mcc'], failedRepos: ['agent-comms'], driftStatus: 'clean',
    }));
    const notified = path.join(root, 'notified.json');
    fs.writeFileSync(notified, JSON.stringify({
      'tmux-mcc#1': { marcus: 'x' },        // swept, no longer open -> drops
      'agent-comms#9': { marcus: 'x' },     // NOT swept -> must be kept
    }));
    const renv = runnerEnv(root, findings, {
      OPEN_PR_DIGEST_MAIL_BIN: mailStub(root, path.join(root, 'mail.log')),
      OPEN_PR_DIGEST_RUN_ID: 'fixed-run',
      OPEN_PR_DIGEST_NOTIFIED_PATH: notified,
    });
    runRunner(renv);
    expect(Object.keys(JSON.parse(fs.readFileSync(notified, 'utf8')))).toEqual(['agent-comms#9']);
  });

  it('(9) PER-RECIPIENT: a persistent failure to one does not re-mail the other', () => {
    // isla's finding 9. `allOk` was my fix for Zara's dc-20261015-002 point that state must
    // advance only on delivery, and I overcorrected: with two recipients a PERSISTENT failure
    // to one re-mails the OTHER every single day, which is how a real signal earns the right
    // to be ignored.
    const root = tempDir();
    const src = makeCheckouts(root, '2026-10-29T18:00:00Z');
    const env = baseEnv(root, { 'jeremys-labs/tmux-mcc': [pr()] }, src);
    sweep(env);
    const log = path.join(root, 'mail.log');
    const renv = runnerEnv(root, env.OPEN_PR_DIGEST_FINDINGS_PATH, {
      OPEN_PR_DIGEST_MAIL_BIN: mailStub(root, log, 'isla'),   // isla always fails
    });

    runRunner(renv);
    expect(mailLines(log)).toHaveLength(2);                    // both attempted
    const first = JSON.parse(fs.readFileSync(path.join(root, 'notified.json'), 'utf8'));
    expect(Object.keys(first['tmux-mcc#36'])).toEqual(['marcus']);   // only the delivered one

    // Second run: marcus is NOT re-mailed, isla IS re-attempted.
    runRunner(renv);
    const lines = mailLines(log);
    expect(lines).toHaveLength(3);
    expect(lines[2]).toContain('--to isla');
    expect(lines.filter((l) => l.includes('--to marcus'))).toHaveLength(1);
  });

  it('(5b) a FAILED send does not advance state, so the transition is not lost', () => {
    const root = tempDir();
    const src = makeCheckouts(root, '2026-10-29T18:00:00Z');
    const env = baseEnv(root, { 'jeremys-labs/tmux-mcc': [pr()] }, src);
    sweep(env);
    const renv = runnerEnv(root, env.OPEN_PR_DIGEST_FINDINGS_PATH, {
      OPEN_PR_DIGEST_MAIL_BIN: '/usr/bin/false',
    });
    runRunner(renv);
    expect(JSON.parse(fs.readFileSync(path.join(root, 'notified.json'), 'utf8'))).toEqual({});
    expect(status(root).routing.delivered).toBe(0);
    expect(status(root).routing.failed.length).toBeGreaterThan(0);   // visible, not swallowed
  });

  it('(5e) a PR that leaves and re-enters the undispositioned set is notified AGAIN', () => {
    // M9 SURVIVED without this: dropping the notified-state intersection changed nothing, so
    // the line was undefended. The case is reachable under the merge rule -- a PR gets a
    // verdict, a new push invalidates it on the exact head, and it goes undispositioned again.
    const root = tempDir();
    const src = makeCheckouts(root, '2026-10-29T18:00:00Z');
    const log = path.join(root, 'mail.log');
    const findings = path.join(root, 'findings.json');
    const renv = runnerEnv(root, findings, { OPEN_PR_DIGEST_MAIL_BIN: mailStub(root, log) });

    const open = baseEnv(root, { 'jeremys-labs/tmux-mcc': [pr()] }, src);
    open.OPEN_PR_DIGEST_FINDINGS_PATH = findings;
    open.OPEN_PR_DIGEST_RUN_ID = 'r1';
    sweep(open);
    runRunner({ ...renv, OPEN_PR_DIGEST_RUN_ID: 'r1' });
    expect(mailLines(log)).toHaveLength(2);

    // it gets a verdict on the current head: it leaves the set, and the state sheds the key
    const reviewed = baseEnv(root, { 'jeremys-labs/tmux-mcc': [pr({ comments: [verdict(HEAD_OID)] })] }, src);
    reviewed.OPEN_PR_DIGEST_FINDINGS_PATH = findings;
    reviewed.OPEN_PR_DIGEST_RUN_ID = 'r2';
    sweep(reviewed);
    runRunner({ ...renv, OPEN_PR_DIGEST_RUN_ID: 'r2' });
    expect(JSON.parse(fs.readFileSync(path.join(root, 'notified.json'), 'utf8'))).toEqual({});

    // a new push invalidates the verdict: it re-enters, and the author must hear about it
    open.OPEN_PR_DIGEST_RUN_ID = 'r3';
    sweep(open);
    runRunner({ ...renv, OPEN_PR_DIGEST_RUN_ID: 'r3' });
    expect(mailLines(log)).toHaveLength(4);
  });

  it('(5c) an unresolvable author routes to the operator and SAYS it is unresolved', () => {
    const root = tempDir();
    const src = makeCheckouts(root, '2026-10-29T18:00:00Z');
    const env = baseEnv(root, { 'jeremys-labs/tmux-mcc': [pr({ headRefName: 'dependabot/npm/x' })] }, src);
    const r = sweep(env);
    expect(r.findings.undispositioned[0].authorAgent).toBe(null);
    expect(r.findings.undispositioned[0].authorUnresolvedReason).toContain('no roster-agent prefix');
    expect(r.stdout).toContain('UNRESOLVED');
  });

  it('(5d) an unreadable roster yields an unresolved author, never a guessed one', () => {
    const root = tempDir();
    const src = makeCheckouts(root, '2026-10-29T18:00:00Z');
    const r = sweep(baseEnv(root, { 'jeremys-labs/tmux-mcc': [pr()] }, src, null));
    expect(r.findings.rosterReadable).toBe(false);
    expect(r.findings.undispositioned[0].authorAgent).toBe(null);
    expect(r.findings.undispositioned[0].authorUnresolvedReason).toBe('roster unreadable');
  });
});
