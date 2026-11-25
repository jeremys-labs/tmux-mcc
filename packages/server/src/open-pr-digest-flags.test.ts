/**
 * The SWEEP half of dc-20261021-001: every spec that exercises `open-pr-digest.mjs` without the
 * runner. Split under dc-20261125-vitest-worker -- see open-pr-digest-fixtures.ts for why.
 */
import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_HEAD_DATES,
  HEAD_OID,
  NOW,
  SWEEP,
  baseEnv,
  cleanupRoots,
  comment,
  git,
  makeCheckouts,
  pr,
  roster,
  status,
  sweep,
  tempDir,
  verdict,
} from './open-pr-digest-fixtures.js';

afterEach(cleanupRoots);

describe('dc-20261021-001 — open-PR digest flags — sweep', () => {
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
  const noFire = (over: Record<string, unknown>, repo = 'jeremys-labs/tmux-mcc',
                  headDates: Record<string, string> = DEFAULT_HEAD_DATES) => {
    const root = tempDir();
    const src = makeCheckouts(root, '2026-10-29T18:00:00Z');
    return sweep(baseEnv(root, { [repo]: [pr(over)] }, src, ['marcus', 'eli', 'isla'], headDates));
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
    expect(noFire({}, 'jeremys-labs/tmux-mcc', { [HEAD_OID]: '2026-10-30T10:00:00Z' })
      .findings.undispositioned).toHaveLength(0);
  });

  it('(2h) THE GRACE RUNS FROM THE HEAD, NOT FROM createdAt', () => {
    // isla's finding 8. Once the verdict is per-head, a grace measured from PR creation lets a
    // PR re-pushed an hour ago skip the grace on its NEW head: it is already "5 days old", so
    // the new head is flagged before anyone could have looked at it.
    const r = noFire(
      { createdAt: '2026-10-25T12:00:00Z' },                     // 120h old PR
      'jeremys-labs/tmux-mcc',
      { [HEAD_OID]: '2026-10-30T10:00:00Z' },                    // head pushed 2h ago
    );
    expect(r.findings.undispositioned).toHaveLength(0);
  });

  it('(2e) SCOPE: an ancient unreviewed non-agent-repo PR does not fire', () => {
    const r = noFire({ createdAt: '2026-01-01T00:00:00Z' }, 'jeremys-labs/str-ops',
                     { [HEAD_OID]: '2026-01-01T00:00:00Z' });
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

  it('(3g) ON MAIN BUT AHEAD IS NOT at-main: unmerged code is deployed there', () => {
    // CODEX P2 on 02a070f, accepted and reproduced with real git before fixing. `behindCount`
    // counts only what HEAD is MISSING, so it is 0 both when level AND when ahead -- so a local
    // `main` with unpushed commits reported `at-main` and claimed "level with origin/main".
    // The same false reading `not-on-main` was added to prevent, for every branch EXCEPT main.
    const root = tempDir();
    const src = makeCheckouts(root, '2026-10-29T18:00:00Z');
    const mcc = path.join(src, 'mcc-tmux');          // the at-main control repo
    fs.writeFileSync(path.join(mcc, 'local'), 'x');
    git(mcc, ['add', 'local']); git(mcc, ['commit', '-qm', 'local only']);
    const r = sweep(baseEnv(root, {}, src));
    const d = r.findings.drifts.find((x: any) => x.repo === 'tmux-mcc');
    expect(d.state).toBe('ahead');
    expect(d.state).not.toBe('at-main');
    expect(d.aheadCount).toBe(1);
    expect(r.findings.driftStatus).toBe('problems');
    expect(r.stdout).toContain('AHEAD of origin/main');
  });

  it('(3h) ahead AND behind is DIVERGED, not either one alone', () => {
    const root = tempDir();
    const src = makeCheckouts(root, '2026-10-28T00:00:00Z');
    const sup = path.join(src, 'agent-supervisor');  // already behind
    fs.writeFileSync(path.join(sup, 'local'), 'x');
    git(sup, ['add', 'local']); git(sup, ['commit', '-qm', 'local only']);
    const r = sweep(baseEnv(root, {}, src));
    const d = r.findings.drifts.find((x: any) => x.repo === 'agent-supervisor');
    expect(d.state).toBe('diverged');
    expect(d.aheadCount).toBe(1);
    expect(d.behindCount).toBeGreaterThan(0);
  });

  it('(12) THE SWEEP NEVER ASKS gh FOR `commits`: a node-limit refusal takes the whole digest down', () => {
    // isla's step-3 finding on 02a070f, and the most consequential defect in this row.
    // MEASURED against the real gh: `commits` at --limit 50 makes the GraphQL query request
    // 505,050 possible nodes against a hard 500,000 limit, so the call exits 1 FOR EVERY REPO.
    // The live digest at that head opened with "0 open, 0 flagged" and "No open PRs across
    // fleet repos. 🎉" where origin/main reported 9 open / 7 flagged.
    //
    // THE STUB HERE REFUSES THE WAY REAL gh REFUSES, with the real error text, because my
    // twelve-mutation battery could not see any of this: every test stubbed `gh` with something
    // easier to satisfy than the thing it stood for.
    const root = tempDir();
    const src = makeCheckouts(root, '2026-10-29T18:00:00Z');
    const strict = path.join(root, 'gh-nodelimit');
    fs.writeFileSync(strict, `#!/usr/bin/env node
const argv = process.argv.slice(2);
const j = argv.indexOf('--json');
if (j >= 0 && String(argv[j + 1]).split(',').includes('commits')) {
  process.stderr.write('GraphQL: This query requests up to 505,050 possible nodes which exceeds the maximum limit of 500,000.\\n');
  process.exit(1);
}
if (argv[0] === 'api') { process.stdout.write('2026-10-25T12:00:00Z'); process.exit(0); }
const i = argv.indexOf('--repo');
const fixtures = ${JSON.stringify({ 'jeremys-labs/tmux-mcc': [pr()] })};
process.stdout.write(JSON.stringify(fixtures[argv[i + 1]] ?? []));
`);
    fs.chmodSync(strict, 0o755);
    const r = sweep({ ...baseEnv(root, {}, src), OPEN_PR_DIGEST_GH_BIN: strict });
    expect(r.findings.failedRepos).toEqual([]);          // no repo refused
    expect(r.findings.sweptRepos).toHaveLength(8);
    expect(r.stdout).toContain('1 open');                 // and the digest is NOT blank
    expect(r.stdout).not.toContain('No open PRs across fleet repos');
    expect(r.status).toBe(0);
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
  // --- isla's review of b1a8613: the three items, each with the control that discriminates it --

  it('(16) AN EMPTY LIST IS NOT GOOD NEWS WHEN EVERY REPO FAILED TO SWEEP', () => {
    // The 🎉 at open-pr-digest.mjs:444 fired on `prs.length === 0` unconditionally, so the
    // node-limit refusal produced a party emoji over a blanked report -- the digest Jeremy
    // reads, saying the opposite of the truth. Fixing the node limit removed that cause; it did
    // not remove the line, and any future whole-fleet failure reaches it the same way.
    const root = tempDir();
    const src = makeCheckouts(root, '2026-10-29T18:00:00Z');
    const dead = path.join(root, 'gh-dead');
    fs.writeFileSync(dead, `#!/usr/bin/env node
const argv = process.argv.slice(2);
if (argv[0] === 'api') { process.stdout.write('2026-10-25T12:00:00Z'); process.exit(0); }
process.stderr.write('gh: could not reach github.com\\n');
process.exit(1);
`);
    fs.chmodSync(dead, 0o755);
    const r = sweep({ ...baseEnv(root, {}, src), OPEN_PR_DIGEST_GH_BIN: dead });
    expect(r.findings.failedRepos).toHaveLength(8);
    expect(r.findings.sweptRepos).toEqual([]);
    expect(r.stdout).toContain('NO DATA');
    expect(r.stdout).not.toContain('🎉');
    expect(r.status).toBe(1);                          // and the sweep failing IS the exit code
  });

  it('(16b) a genuinely empty fleet still says so, and still celebrates', () => {
    // The paired control. Suppressing the good-news line whenever the list is empty would make
    // "nothing to do" permanently indistinguishable from "everything broke", which is the same
    // conflation one direction over.
    const root = tempDir();
    const src = makeCheckouts(root, '2026-10-30T12:00:00Z');   // at main: no drift noise
    const r = sweep(baseEnv(root, {}, src));
    expect(r.findings.failedRepos).toEqual([]);
    expect(r.stdout).toContain('No open PRs across fleet repos. 🎉');
    expect(r.stdout).not.toContain('NO DATA');
  });

  it('(3i) THE ORIGIN-MOVED BASIS SURVIVES PAST THE 100th REFLOG ENTRY', () => {
    // Codex P2. The walk was `entries.slice(0, 100)` over a list reversed to oldest-first, so
    // it kept the OLDEST hundred and threw away the NEWEST -- which is where a recently-learned
    // commit's entry lives. MEASURED on the live checkouts this flag sweeps: SHARED is at 137
    // entries today, so this was already broken in production, on the long-lived deploy
    // checkout the feature exists for.
    //
    // The fixture controls the reflog completely: the ref's log is removed and rebuilt as 102
    // old entries that do NOT contain the commit, then the one that does, an hour ago.
    const root = tempDir();
    const src = makeCheckouts(root, '2026-10-20T12:00:00Z', '2026-10-30T06:00:00Z');
    const sup = path.join(src, 'agent-supervisor');
    const one = git(sup, ['rev-parse', 'HEAD']).trim();                 // does NOT contain 'two'
    const two = git(sup, ['rev-parse', 'refs/remotes/origin/main']).trim();
    // EVERY ENTRY MUST REALLY MOVE THE REF: `update-ref` writes NO reflog entry when the value
    // is unchanged, so the first version of this fixture produced two entries and asserted its
    // way to a red. That is a constraint on MOVEMENT, not on uniqueness -- see below, where two
    // alternating shas satisfy it. Neither pad value contains `two`.
    // SPEED, and the property is unchanged (dc-20261125-digest-red). This used to make 102
    // empty commits and then 102 `update-ref` calls -- 204 git processes, 7.5s, over the 5s
    // limit. Two changes, neither of which touches what is asserted:
    //   1. ONE extra commit instead of 102. The pad entries only have to NOT contain `two`,
    //      and they must each really MOVE the ref (`update-ref` writes no entry when the value
    //      is unchanged -- the original fixture's own hard-won note). ALTERNATING two shas
    //      moves it every time, so distinctness was never the requirement.
    //   2. Write the reflog file directly instead of spawning 102 `update-ref`s. The fixture
    //      already deletes and rebuilds this exact file, so this is the same act with one
    //      write; and the 103-entry assertion below is the format's own check -- if the lines
    //      are malformed, `git reflog show` cannot parse them and the fixture fails loudly
    //      instead of passing for the wrong reason.
    const branch = git(sup, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    git(sup, ['checkout', '-q', '-b', 'pad']);
    git(sup, ['commit', '-q', '--allow-empty', '-m', 'pad'], '2026-10-20T13:00:00Z');
    const padSha = git(sup, ['rev-parse', 'HEAD']).trim();   // empty commit off `one`
    git(sup, ['checkout', '-q', branch]);

    const logPath = path.join(sup, '.git/logs/refs/remotes/origin/main');
    const who = 'Fixture <fixture@example.com>';
    const padTs = Math.floor(Date.parse('2026-10-20T13:00:00Z') / 1000);
    const twoTs = Math.floor(Date.parse('2026-10-30T11:00:00Z') / 1000);
    const lines: string[] = [];
    let prev = one;
    for (let i = 0; i < 102; i += 1) {
      const next = i % 2 === 0 ? padSha : one;   // alternate: every update really moves it
      lines.push(`${prev} ${next} ${who} ${padTs} +0000\tupdate-ref: pad ${i}`);
      prev = next;
    }
    lines.push(`${prev} ${two} ${who} ${twoTs} +0000\tupdate-ref: learned two`);
    fs.writeFileSync(logPath, `${lines.join('\n')}\n`);
    expect(git(sup, ['reflog', 'show', '--format=%H', 'refs/remotes/origin/main'])
      .trim().split('\n')).toHaveLength(103);        // the fixture really is past the cap

    const r = sweep(baseEnv(root, {}, src));
    const d = r.findings.drifts.find((x: any) => x.repo === 'agent-supervisor');
    expect(d.ageBasis).toBe('origin-moved');         // not the commit-date fallback
    expect(d.hoursBehind).toBe(1);                   // learned an hour ago
    expect(d.overGrace).toBe(false);                 // and so NOT a drift finding
  });

  it('(16c) A PARTIAL SWEEP FAILURE DOES NOT SAY "ALL"', () => {
    // isla's review of a32fcb1. The line I added to stop one false claim carried another: N was
    // `failures.length`, so three failures out of eight repos with no open PRs in the five that
    // DID sweep read "all 3 repo sweep(s) failed". A false count inside the fix for a false
    // claim, in the digest Jeremy reads.
    const root = tempDir();
    const src = makeCheckouts(root, '2026-10-30T12:00:00Z');       // at main: no drift noise
    const flaky = path.join(root, 'gh-flaky');
    fs.writeFileSync(flaky, `#!/usr/bin/env node
const argv = process.argv.slice(2);
if (argv[0] === 'api') { process.stdout.write('2026-10-25T12:00:00Z'); process.exit(0); }
const repo = argv[argv.indexOf('--repo') + 1] || '';
// Three of the eight refuse; the rest sweep cleanly and have nothing open.
if (/(agent-comms|deal-analyzer|str-ops)/.test(repo)) {   // three names READ from REPOS, not recalled
  process.stderr.write('gh: could not reach github.com\\n');
  process.exit(1);
}
process.stdout.write('[]');
`);
    fs.chmodSync(flaky, 0o755);
    const r = sweep({ ...baseEnv(root, {}, src), OPEN_PR_DIGEST_GH_BIN: flaky });
    expect(r.findings.failedRepos).toHaveLength(3);
    expect(r.findings.sweptRepos).toHaveLength(5);
    expect(r.stdout).toContain('PARTIAL: 3 of 8 repo sweeps failed');
    expect(r.stdout).toContain('the 5 that ran have no open PRs');
    expect(r.stdout).not.toContain('all 3');                        // the false count
    expect(r.stdout).not.toContain('NO DATA');                      // not a total blackout
    expect(r.stdout).not.toContain('🎉');                           // and not good news either
  });

});
