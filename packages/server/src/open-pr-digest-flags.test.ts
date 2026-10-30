// dc-20261021-001 acceptance. Five criteria, each with the control that discriminates it:
// a case that fires is paired with a case that must NOT, because a flag that fires on
// everything is as broken as one that fires on nothing, and noisier.
//
// The git fixtures are REAL repositories, not stubs. Yesterday on dc-20261017-001 a control
// over a string-compared path passed while the bug it guarded was reverted, because the
// fixture could not express the difference; real git is what makes "behind", "at main" and
// "detached" distinguishable rather than asserted.
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
 * Builds a real origin plus three checkouts. `missingCommitAt` is the commit date of the
 * commit the behind-clone lacks: the flag measures the age of the OLDEST MISSING commit, so
 * this is the knob that makes ">24h behind" deterministic rather than a wait.
 */
function makeCheckouts(root: string, missingCommitAt: string) {
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
  // advance origin by one commit, dated so the clones are "behind" by a known age
  fs.writeFileSync(path.join(seed, 'b'), '2');
  git(seed, ['add', 'b']); git(seed, ['commit', '-qm', 'two'], missingCommitAt);
  git(seed, ['push', '-q', 'origin', 'main']);

  // agent-supervisor: BEHIND. mcc-tmux: AT MAIN. agent-comms: DETACHED.
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

function pr(over: Record<string, unknown> = {}) {
  return {
    number: 36, title: 'a pr', body: '', createdAt: '2026-10-25T12:00:00Z',
    updatedAt: '2026-10-29T12:00:00Z', reviewDecision: '', isDraft: false,
    reviewRequests: [], assignees: [], files: [], headRefName: 'marcus/thing', ...over,
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
  };
}

describe('dc-20261021-001 — open-PR digest flags', () => {
  it('(1) fires on an agent-repo PR with no review verdict past 24h', () => {
    const root = tempDir();
    const src = makeCheckouts(root, '2026-10-29T18:00:00Z'); // behind by 18h: under grace
    const r = sweep(baseEnv(root, { 'jeremys-labs/tmux-mcc': [pr()] }, src));
    expect(r.stdout).toContain('No review verdict after 24h');
    expect(r.stdout).toContain('tmux-mcc #36');
    expect(r.findings.undispositioned).toHaveLength(1);
    expect(r.findings.undispositioned[0].hoursOpen).toBe(120);
  });

  // SPLIT INTO ONE TEST PER PROPERTY. As a single table-driven test these four cases shared
  // ONE control: mutating away the 24h grace, the agent-repo scope, or the draft exclusion all
  // turned the SAME test red, so no one of them was individually pinned and deleting a row from
  // the table would have silently retired a property. That is the defect Hercule found in my
  // 3b/3c yesterday and the one I raised on Eli's "bounded parallelism" this morning -- third
  // instance in a day, this one in the suite I had just written.
  const noFire = (over: Record<string, unknown>, repo = 'jeremys-labs/tmux-mcc') => {
    const root = tempDir();
    const src = makeCheckouts(root, '2026-10-29T18:00:00Z');
    return sweep(baseEnv(root, { [repo]: [pr(over)] }, src));
  };

  it('(2a) an APPROVED review is dispositioned and does not fire', () => {
    const r = noFire({ reviewDecision: 'APPROVED' });
    expect(r.findings.undispositioned).toHaveLength(0);
    expect(r.stdout).not.toContain('No review verdict');
  });

  it('(2b) CHANGES_REQUESTED is also a rendered verdict and does not fire', () => {
    expect(noFire({ reviewDecision: 'CHANGES_REQUESTED' }).findings.undispositioned).toHaveLength(0);
  });

  it('(2c) a DRAFT is not asking for review yet and does not fire', () => {
    expect(noFire({ isDraft: true }).findings.undispositioned).toHaveLength(0);
  });

  it('(2d) a PR open only 2h is under the grace and does not fire', () => {
    expect(noFire({ createdAt: '2026-10-30T10:00:00Z' }).findings.undispositioned).toHaveLength(0);
  });

  it('(2e) SCOPE: an ancient unreviewed non-agent-repo PR does not fire', () => {
    // The row is agent repos only. str-ops #70 has been open 107 days in real life.
    const r = noFire({ createdAt: '2026-01-01T00:00:00Z' }, 'jeremys-labs/str-ops');
    expect(r.findings.undispositioned).toHaveLength(0);
  });

  it('(3) flags a checkout behind origin/main past 24h and not one at main', () => {
    const root = tempDir();
    const src = makeCheckouts(root, '2026-10-28T00:00:00Z'); // oldest missing commit 60h old
    const r = sweep(baseEnv(root, {}, src));
    const by = Object.fromEntries(r.findings.drifts.map((d: any) => [d.repo, d]));
    expect(by['agent-supervisor'].state).toBe('behind');
    expect(by['agent-supervisor'].overGrace).toBe(true);
    expect(by['agent-supervisor'].hoursBehind).toBe(60);
    // KEYED ON THE GITHUB REPO NAME, which is `tmux-mcc` while the DIRECTORY is `mcc-tmux`.
    // I wrote the comment warning about exactly this confusion in the sweep and then made the
    // mistake here, one file over; the finding carries `dir` separately for the path.
    expect(by['tmux-mcc'].state).toBe('at-main');      // the control
    expect(by['tmux-mcc'].dir.endsWith('/mcc-tmux')).toBe(true);
    expect(r.status).toBe(1);
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
    // isla's amendment. It happened in the live agent-supervisor checkout on 2026-10-19, and a
    // detached HEAD can sit at main's tip while not being ON main, so a two-state flag is wrong
    // in one direction or the other whatever it answers.
    const root = tempDir();
    const src = makeCheckouts(root, '2026-10-28T00:00:00Z');
    const r = sweep(baseEnv(root, {}, src));
    const comms = r.findings.drifts.find((d: any) => d.repo === 'agent-comms');
    expect(comms.state).toBe('detached');
    expect(comms.state).not.toBe('at-main');
    expect(comms.state).not.toBe('behind');
    expect(r.stdout).toContain('DETACHED');
  });

  it('(4) an unreadable git yields cannot-determine and a NON-ZERO exit, never clean', () => {
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
    expect(r.status).toBe(1);            // an unanswerable check must not read as healthy
    expect(r.stdout).toContain('cannot-determine');
  });

  it('(4b) an absent checkout directory is cannot-determine, not at-main', () => {
    const root = tempDir();
    const r = sweep(baseEnv(root, {}, path.join(root, 'nope')));
    expect(r.findings.drifts.every((d: any) => d.state === 'cannot-determine')).toBe(true);
    expect(r.status).toBe(1);
  });

  it('(5) the finding reaches the AUTHOR and the operator, once, and only on delivery', () => {
    const root = tempDir();
    const src = makeCheckouts(root, '2026-10-29T18:00:00Z');
    const env = baseEnv(root, { 'jeremys-labs/tmux-mcc': [pr()] }, src);
    sweep(env);
    expect(env.OPEN_PR_DIGEST_FINDINGS_PATH).toBeTruthy();

    const log = path.join(root, 'mail.log');
    const mail = path.join(root, 'agent-mail');
    fs.writeFileSync(mail, `#!/usr/bin/env node
require('fs').appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ') + '\\n');
`);
    fs.chmodSync(mail, 0o755);
    const notified = path.join(root, 'notified.json');
    const runnerEnv = {
      ...process.env,
      OPEN_PR_DIGEST_SCRIPT: path.join(root, 'noop.mjs'),
      OPEN_PR_DIGEST_STATUS_PATH: path.join(root, 'status.json'),
      OPEN_PR_DIGEST_FINDINGS_PATH: env.OPEN_PR_DIGEST_FINDINGS_PATH,
      OPEN_PR_DIGEST_NOTIFIED_PATH: notified,
      OPEN_PR_DIGEST_MAIL_BIN: mail,
      OPEN_PR_DIGEST_AGENT: 'marcus',
    };
    fs.writeFileSync(path.join(root, 'noop.mjs'), 'console.log("x");');

    spawnSync('node', [RUNNER, '--dry-run'], { encoding: 'utf8', env: runnerEnv });
    const sent = fs.readFileSync(log, 'utf8');
    // THE POINT OF THE ROW: the author, not only the reader of the digest.
    expect(sent).toContain('--to marcus');
    expect(sent).toContain('--to isla');
    const firstRunLines = sent.trim().split('\n').length;
    expect(firstRunLines).toBe(2);

    // TRANSITION-ONLY: a second run tells nobody again.
    spawnSync('node', [RUNNER, '--dry-run'], { encoding: 'utf8', env: runnerEnv });
    expect(fs.readFileSync(log, 'utf8').trim().split('\n').length).toBe(firstRunLines);
    expect(Object.keys(JSON.parse(fs.readFileSync(notified, 'utf8')))).toEqual(['tmux-mcc#36']);
  });

  it('(5b) a FAILED send does not advance state, so the transition is not lost', () => {
    // Zara's finding on dc-20261015-002: alert() returned false and the new state was written
    // anyway, losing the transition permanently. Driven through the real path with a mail
    // binary that always fails.
    const root = tempDir();
    const src = makeCheckouts(root, '2026-10-29T18:00:00Z');
    const env = baseEnv(root, { 'jeremys-labs/tmux-mcc': [pr()] }, src);
    sweep(env);
    const notified = path.join(root, 'notified.json');
    fs.writeFileSync(path.join(root, 'noop.mjs'), 'console.log("x");');
    const r = spawnSync('node', [RUNNER, '--dry-run'], { encoding: 'utf8', env: {
      ...process.env,
      OPEN_PR_DIGEST_SCRIPT: path.join(root, 'noop.mjs'),
      OPEN_PR_DIGEST_STATUS_PATH: path.join(root, 'status.json'),
      OPEN_PR_DIGEST_FINDINGS_PATH: env.OPEN_PR_DIGEST_FINDINGS_PATH,
      OPEN_PR_DIGEST_NOTIFIED_PATH: notified,
      OPEN_PR_DIGEST_MAIL_BIN: '/usr/bin/false',
      OPEN_PR_DIGEST_AGENT: 'marcus',
    } });
    expect(JSON.parse(fs.readFileSync(notified, 'utf8'))).toEqual({});
    const status = JSON.parse(fs.readFileSync(path.join(root, 'status.json'), 'utf8'));
    expect(status.routing.delivered).toBe(0);
    expect(status.routing.failed.length).toBeGreaterThan(0);   // visible, not swallowed
    expect(r.status).not.toBe(null);
  });

  it('(5e) a PR that leaves and re-enters the undispositioned set is notified AGAIN', () => {
    // M9 SURVIVED without this: dropping the notified-state intersection changed nothing, so
    // the line was undefended. The case is reachable under the merge rule -- a PR gets a
    // verdict, a new push invalidates it on the exact head, and it goes undispositioned again.
    // With a stale key the author is never told the second time, which is the surface-check
    // journal's founding bug (a state entry suppressing a live report) in a new place.
    const root = tempDir();
    const src = makeCheckouts(root, '2026-10-29T18:00:00Z');
    const log = path.join(root, 'mail.log');
    const mail = path.join(root, 'agent-mail');
    fs.writeFileSync(mail, `#!/usr/bin/env node
require('fs').appendFileSync(${JSON.stringify('PLACEHOLDER')}, process.argv.slice(2).join(' ') + '\\n');
`.replace(JSON.stringify('PLACEHOLDER'), JSON.stringify(log)));
    fs.chmodSync(mail, 0o755);
    const notified = path.join(root, 'notified.json');
    const findings = path.join(root, 'findings.json');
    fs.writeFileSync(path.join(root, 'noop.mjs'), 'console.log("x");');
    const env = {
      ...process.env,
      OPEN_PR_DIGEST_SCRIPT: path.join(root, 'noop.mjs'),
      OPEN_PR_DIGEST_STATUS_PATH: path.join(root, 'status.json'),
      OPEN_PR_DIGEST_FINDINGS_PATH: findings,
      OPEN_PR_DIGEST_NOTIFIED_PATH: notified,
      OPEN_PR_DIGEST_MAIL_BIN: mail,
      OPEN_PR_DIGEST_AGENT: 'marcus',
    };
    const sweepEnv = baseEnv(root, { 'jeremys-labs/tmux-mcc': [pr()] }, src);
    sweepEnv.OPEN_PR_DIGEST_FINDINGS_PATH = findings;

    sweep(sweepEnv);                                             // undispositioned
    spawnSync('node', [RUNNER, '--dry-run'], { encoding: 'utf8', env });
    const afterFirst = fs.readFileSync(log, 'utf8').trim().split('\n').length;
    expect(afterFirst).toBe(2);

    // it gets a verdict: it leaves the set, and the state must shed the key
    const approved = baseEnv(root, { 'jeremys-labs/tmux-mcc': [pr({ reviewDecision: 'APPROVED' })] }, src);
    approved.OPEN_PR_DIGEST_FINDINGS_PATH = findings;
    sweep(approved);
    spawnSync('node', [RUNNER, '--dry-run'], { encoding: 'utf8', env });
    expect(JSON.parse(fs.readFileSync(notified, 'utf8'))).toEqual({});

    // a new push invalidates the verdict: it re-enters, and the author must hear about it
    sweep(sweepEnv);
    spawnSync('node', [RUNNER, '--dry-run'], { encoding: 'utf8', env });
    expect(fs.readFileSync(log, 'utf8').trim().split('\n').length).toBe(afterFirst + 2);
  });

  it('(5c) an unresolvable author routes to the operator and SAYS it is unresolved', () => {
    const root = tempDir();
    const src = makeCheckouts(root, '2026-10-29T18:00:00Z');
    // branch with no roster-agent prefix
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
