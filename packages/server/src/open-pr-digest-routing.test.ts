/**
 * The ROUTING half of dc-20261021-001: every spec that runs `run-open-pr-digest.mjs`.
 * Split under dc-20261125-vitest-worker -- see open-pr-digest-fixtures.ts for why.
 */
import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FIXTURE_RUN,
  HEAD_OID,
  SWEEP,
  baseEnv,
  cleanupRoots,
  mailBodies,
  mailLines,
  mailStub,
  makeCheckouts,
  pr,
  runRunner,
  runRunnerExpectFail,
  runnerEnv,
  status,
  sweep,
  tempDir,
  verdict,
} from './open-pr-digest-fixtures.js';

afterEach(cleanupRoots);

describe('dc-20261021-001 — open-PR digest flags — routing', () => {
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
    runRunnerExpectFail(renv);
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
      'tmux-mcc#1': { head: 'aaa', recipients: { marcus: 'x' } },     // swept, not open -> drops
      'agent-comms#9': { head: 'bbb', recipients: { marcus: 'x' } },  // NOT swept -> must be kept
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

    runRunnerExpectFail(renv);
    expect(mailLines(log)).toHaveLength(2);                    // both attempted
    const first = JSON.parse(fs.readFileSync(path.join(root, 'notified.json'), 'utf8'));
    expect(Object.keys(first['tmux-mcc#36'].recipients)).toEqual(['marcus']);  // only the delivered one
    expect(first['tmux-mcc#36'].head).toBe(HEAD_OID);                          // and the head it was for

    // Second run: marcus is NOT re-mailed, isla IS re-attempted.
    runRunnerExpectFail(renv);
    const lines = mailLines(log);
    expect(lines).toHaveLength(3);
    expect(lines[2]).toContain('--to isla');
    expect(lines.filter((l) => l.includes('--to marcus'))).toHaveLength(1);
  });

  it('(9b) A FAILED SEND RECORDS WHY, not just that it failed', () => {
    // isla, dc-20261125-vitest-worker. `routing.failed` held `tmux-mcc#36 -> isla` and nothing
    // else, so a REAL defect -- a body file two concurrent runs shared, ENOENT on the second
    // send -- was indistinguishable from a flaky test, and we chased it for an afternoon. The
    // mail binary had been saying ENOENT the whole time on a stderr nobody captured. Same
    // "absence of a reason is not a reason" class as the artifact `skipped` field in (18).
    const root = tempDir();
    const src = makeCheckouts(root, '2026-10-29T18:00:00Z');
    const env = baseEnv(root, { 'jeremys-labs/tmux-mcc': [pr()] }, src);
    sweep(env);
    const log = path.join(root, 'mail.log');
    runRunnerExpectFail(runnerEnv(root, env.OPEN_PR_DIGEST_FINDINGS_PATH, {
      OPEN_PR_DIGEST_MAIL_BIN: mailStub(root, log, 'isla'),
    }));
    const failed = status(root).routing.failed;
    expect(failed).toHaveLength(1);
    expect(failed[0]).toContain('tmux-mcc#36 -> isla');   // who, as before
    expect(failed[0]).toContain('no mailbox for isla');   // AND WHY, which is the new part
  });

  it('(5b) a FAILED send does not advance state, so the transition is not lost', () => {
    const root = tempDir();
    const src = makeCheckouts(root, '2026-10-29T18:00:00Z');
    const env = baseEnv(root, { 'jeremys-labs/tmux-mcc': [pr()] }, src);
    sweep(env);
    const renv = runnerEnv(root, env.OPEN_PR_DIGEST_FINDINGS_PATH, {
      OPEN_PR_DIGEST_MAIL_BIN: '/usr/bin/false',
    });
    runRunnerExpectFail(renv);
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

  it('(11) A NEW HEAD RE-NOTIFIES EVEN WITH NO SWEEP ON THE REVIEWED STATE IN BETWEEN', () => {
    // CODEX P2 on 02a070f, accepted, and it is a path (5e) deliberately does not walk.
    // (5e) runs a sweep ON the reviewed state between the two notifications. Codex's case has
    // NO such sweep: between daily runs the PR gets a verdict for H1 AND a push to H2, so at
    // the next sweep the verdict is STALE against H2, the PR is still undispositioned, the key
    // is never trimmed, every recipient is already recorded, `pending` is empty -- and nobody
    // is told the new head needs re-review. The surface-check-journal founding bug again: a
    // state entry suppressing a live report.
    const root = tempDir();
    const src = makeCheckouts(root, '2026-10-29T18:00:00Z');
    const log = path.join(root, 'mail.log');
    const findings = path.join(root, 'findings.json');
    const renv = runnerEnv(root, findings, { OPEN_PR_DIGEST_MAIL_BIN: mailStub(root, log) });

    // notified at head H1, no verdict
    const h1 = baseEnv(root, { 'jeremys-labs/tmux-mcc': [pr()] }, src);
    h1.OPEN_PR_DIGEST_FINDINGS_PATH = findings;
    sweep(h1);
    runRunner(renv);
    expect(mailLines(log)).toHaveLength(2);

    // H1 gets a verdict AND a new head H2 arrives -- both between sweeps, so the reviewed
    // state is never observed. The PR is STILL undispositioned, now because the verdict is stale.
    const h2 = 'c'.repeat(40);
    const next = baseEnv(root, { 'jeremys-labs/tmux-mcc': [pr({
      headRefOid: h2,
      comments: [verdict(HEAD_OID, 'MUST-CHANGE')],     // verdict for the OLD head
    })] }, src, ['marcus', 'eli', 'isla'], { [h2]: '2026-10-26T12:00:00Z' });
    next.OPEN_PR_DIGEST_FINDINGS_PATH = findings;
    const r = sweep(next);
    expect(r.findings.undispositioned[0].verdict).toBe('stale');
    runRunner(renv);
    expect(mailLines(log)).toHaveLength(4);             // told again, about the new head
  });

  it('(13) ROUTING SETS AGENT_MAIL_DIR, without which the real agent-mail refuses', () => {
    // isla's step-3 finding. The scheduled job's command line sets SCHEDULED_JOB_ID,
    // OPEN_PR_DIGEST_AGENT and OPEN_PR_DIGEST_CHAT_ID and nothing else, so every send from
    // this runner ran with no mailbox while `status` still said ok.
    const root = tempDir();
    const src = makeCheckouts(root, '2026-10-29T18:00:00Z');
    const env = baseEnv(root, { 'jeremys-labs/tmux-mcc': [pr()] }, src);
    sweep(env);
    const log = path.join(root, 'mail.log');
    const renv = runnerEnv(root, env.OPEN_PR_DIGEST_FINDINGS_PATH, {
      OPEN_PR_DIGEST_MAIL_BIN: mailStub(root, log),
    });
    delete renv.AGENT_MAIL_DIR;                 // the job environment does not provide it
    runRunner(renv);
    expect(mailLines(log)).toHaveLength(2);     // the runner supplied it
    expect(status(root).routing.delivered).toBe(2);
  });

  it('(14) A ROUTING FAILURE IS NOT status ok', () => {
    // The control for (13), and its own finding: only the Discord delivery and the sweep exit
    // fed `status`, so the one leg whose whole job is reaching the AUTHOR could fail every day
    // behind a green status.
    const root = tempDir();
    const src = makeCheckouts(root, '2026-10-29T18:00:00Z');
    const env = baseEnv(root, { 'jeremys-labs/tmux-mcc': [pr()] }, src);
    sweep(env);
    const renv = runnerEnv(root, env.OPEN_PR_DIGEST_FINDINGS_PATH, {
      OPEN_PR_DIGEST_MAIL_BIN: '/usr/bin/false',
    });
    // EXACT, not `not.toBe(0)`: "some failure" would have been satisfied by the runner dying
    // for an unrelated reason, which is the blind spot this row is about.
    const r = runRunner(renv, [], { expectStatus: 1 });
    expect(status(root).routing.failed.length).toBeGreaterThan(0);
    expect(status(root).status).toBe('fail');
    expect(status(root).reason).toBe('routing_failed');
    expect(r.status).toBe(1);
  });

  it('(15) THE MAIL CARRIES ONE NUMBER FOR ONE FACT, and it is the one the grace runs from', () => {
    // isla's live run: body "tmux-mcc #36 has had no review verdict for 217h" beside subject
    // "No review verdict after 0h". ONE MAIL, TWO NUMBERS FOR THE SAME FACT -- the body used
    // `hoursOpen` (PR age) and the subject used `hoursSinceHead`.
    //
    // The fixture has to SEPARATE them or it cannot see the bug: a PR opened in January whose
    // head was pushed 48h ago. With them equal, as every earlier fixture had them, the two
    // spellings are indistinguishable and this test would pass against the defect.
    const root = tempDir();
    const src = makeCheckouts(root, '2026-10-29T18:00:00Z');
    const env = baseEnv(root, { 'jeremys-labs/tmux-mcc': [pr({ createdAt: '2026-01-01T00:00:00Z' })] },
                        src, ['marcus', 'eli', 'isla'], { [HEAD_OID]: '2026-10-28T12:00:00Z' });
    const r = sweep(env);
    const f = r.findings.undispositioned[0];
    expect(f.verdict).toBe('missing');
    expect(f.hoursSinceHead).toBe(48);
    expect(f.hoursOpen).toBeGreaterThan(7000);        // the fixture really does separate them

    const log = path.join(root, 'mail.log');
    runRunner(runnerEnv(root, env.OPEN_PR_DIGEST_FINDINGS_PATH, {
      OPEN_PR_DIGEST_MAIL_BIN: mailStub(root, log),
    }));
    const argv = mailLines(log).join('\n');
    const bodies = mailBodies(log);
    expect(argv).toContain('No review verdict after 48h');
    expect(bodies).toContain('has had no review verdict for 48h');
    // The PR-age number must appear NOWHERE in either, which is the actual defect.
    expect(argv).not.toContain(String(f.hoursOpen));
    expect(bodies).not.toContain(String(f.hoursOpen));
  });

  it('(15b) A STALE VERDICT MAIL ASKS FOR A RE-REVIEW, not for a first look', () => {
    // The digest kept "older head" and "nobody looked" apart from the first round; the MAIL did
    // not, so the author of a PR isla had reviewed several times was told nobody had looked at
    // it. Keeping two findings distinct in one surface and collapsed in the other is worse than
    // collapsing them in both, because the two surfaces then disagree about the same PR.
    //
    // THE NUMBER IS ASSERTED HERE TOO (isla, review of a32fcb1). This checked the WORDS and
    // never the hours, so changing the stale subject to `f.hoursOpen` passed 48/48 -- the 217h
    // bug walking straight back in through the other arm. I fixed both arms and pinned ONE,
    // which is the instance-versus-class miss I keep writing down. So this now uses the same
    // separated fixture as (15): a PR opened in January whose head was pushed 48h ago.
    const root = tempDir();
    const src = makeCheckouts(root, '2026-10-29T18:00:00Z');
    const old = 'f'.repeat(40);
    const env = baseEnv(root, {
      'jeremys-labs/tmux-mcc': [pr({ createdAt: '2026-01-01T00:00:00Z', comments: [verdict(old, 'APPROVE')] })],
    }, src, ['marcus', 'eli', 'isla'], { [HEAD_OID]: '2026-10-28T12:00:00Z' });
    const r = sweep(env);
    const f = r.findings.undispositioned[0];
    expect(f.verdict).toBe('stale');
    expect(f.hoursSinceHead).toBe(48);
    expect(f.hoursOpen).toBeGreaterThan(7000);     // the fixture really does separate them

    const log = path.join(root, 'mail.log');
    runRunner(runnerEnv(root, env.OPEN_PR_DIGEST_FINDINGS_PATH, {
      OPEN_PR_DIGEST_MAIL_BIN: mailStub(root, log),
    }));
    const argv = mailLines(log).join('\n');
    const bodies = mailBodies(log);
    expect(argv).toContain('Verdict is for an older head');
    expect(argv).toContain('48h since push');                  // the number, in the SUBJECT
    expect(bodies).toContain('it is for an OLDER head');
    expect(bodies).toContain('pushed 48h ago');                // and in the body
    expect(argv).not.toContain(String(f.hoursOpen));           // never the PR age
    expect(bodies).not.toContain(String(f.hoursOpen));
    expect(bodies).toContain('APPROVE');               // which verdict, and at which sha
    expect(bodies).toContain(old.slice(0, 12));
    expect(bodies).toContain('RE-REVIEW');
    // The false claim this fixes: it must not say nobody rendered a verdict.
    expect(bodies).not.toContain('has had no review verdict');
    expect(bodies).not.toContain('Nobody has rendered a verdict');
  });

  it('(17) A STALE ARTIFACT YIELDS driftStatus unknown, NEVER its stale value', () => {
    // isla's review of b1a8613. `findings?.driftStatus ?? 'unknown'` copied the value whatever
    // its provenance, so yesterday's `clean` sat in today's status beside `findingsFresh:
    // false`. A stale reassurance is worse than no answer: `unknown` sends someone to look,
    // `clean` tells them not to.
    const root = tempDir();
    const findings = path.join(root, 'findings.json');
    fs.writeFileSync(findings, JSON.stringify({
      runId: 'yesterday', undispositioned: [], drifts: [],
      sweptRepos: ['tmux-mcc'], failedRepos: [], driftStatus: 'clean', driftProblems: [],
    }));
    runRunnerExpectFail(runnerEnv(root, findings, {
      OPEN_PR_DIGEST_MAIL_BIN: mailStub(root, path.join(root, 'mail.log')),
    }));
    const st = status(root);
    expect(st.findingsFresh).toBe(false);
    expect(st.driftStatus).toBe('unknown');
    expect(st.driftProblems).toBeUndefined();
  });

  it('(17b) a FRESH artifact does pass its drift verdict through', () => {
    // Without this, returning the literal 'unknown' unconditionally would pass (17), and the
    // field would carry no information at all while looking implemented.
    const root = tempDir();
    const findings = path.join(root, 'findings.json');
    fs.writeFileSync(findings, JSON.stringify({
      runId: FIXTURE_RUN, undispositioned: [], drifts: [],
      sweptRepos: ['tmux-mcc'], failedRepos: [], driftStatus: 'problems',
      driftProblems: [{ repo: 'tmux-mcc', state: 'ahead' }],
    }));
    runRunner(runnerEnv(root, findings, {
      OPEN_PR_DIGEST_MAIL_BIN: mailStub(root, path.join(root, 'mail.log')),
    }));
    expect(status(root).findingsFresh).toBe(true);
    expect(status(root).driftStatus).toBe('problems');
    expect(status(root).driftProblems).toHaveLength(1);
  });

  it('(18) A MISSING ARTIFACT SAYS WHY NOTHING WAS ROUTED', () => {
    // isla's smaller point. `skipped` was left undefined when the artifact was absent, so "the
    // sweep died before writing" and "there was nothing to route" read identically in the
    // status file -- and only the first one needs a human. Absence of a reason is not a reason.
    const root = tempDir();
    runRunnerExpectFail(runnerEnv(root, path.join(root, 'nope.json'), {
      OPEN_PR_DIGEST_MAIL_BIN: mailStub(root, path.join(root, 'mail.log')),
    }));
    const st = status(root);
    expect(st.routing.skipped).toContain('no findings artifact');
    expect(st.routing.attempted).toBe(0);
    expect(st.driftStatus).toBe('unknown');
  });
  // --- Codex P2s on b1a8613, both confirmed at source before accepting ------------------------

  it('(19) A FINDINGS ARTIFACT THAT NEVER ARRIVED IS A FAILURE, NOT status ok', () => {
    // Codex P2, and the half of isla's smaller point I stopped short of. The sweep CATCHES a
    // failed findings write, warns in the human digest and EXITS ZERO, so the exit code does
    // not cover it. The runner then skipped every author notification and -- after I added a
    // `skipped` reason this round -- said WHY while still reporting ok. A reason in a field
    // nobody alerts on is still silent, so author delivery could be broken every day for ever.
    const root = tempDir();
    runRunnerExpectFail(runnerEnv(root, path.join(root, 'never-written.json'), {
      OPEN_PR_DIGEST_MAIL_BIN: mailStub(root, path.join(root, 'mail.log')),
    }));
    const st = status(root);
    expect(st.status).toBe('fail');
    expect(st.reason).toBe('findings_unavailable');
    expect(st.routing.skipped).toContain('no findings artifact');
  });

  it('(19b) AN EMPTY BUT CURRENT ARTIFACT IS A REAL ANSWER AND STAYS ok', () => {
    // The paired control, and the one that stops (19) being satisfied by failing always. A
    // sweep that ran and found nothing undispositioned is the healthy everyday case; treating
    // "no findings" as "no answer" would make the status field fire every quiet day, which is
    // how a real signal gets ignored.
    const root = tempDir();
    const findings = path.join(root, 'findings.json');
    fs.writeFileSync(findings, JSON.stringify({
      runId: FIXTURE_RUN, undispositioned: [], drifts: [],
      sweptRepos: ['tmux-mcc'], failedRepos: [], driftStatus: 'clean', driftProblems: [],
    }));
    runRunner(runnerEnv(root, findings, {
      OPEN_PR_DIGEST_MAIL_BIN: mailStub(root, path.join(root, 'mail.log')),
    }));
    expect(status(root).status).toBe('ok');
    expect(status(root).reason).toBe('sweep_ok');
  });

  it('(19c) --dry-run is not a routing failure', () => {
    // The other direction: dry-run routes nothing BY DESIGN, so it must not read as broken
    // author delivery. Without this, the fix would turn every control run into a fail.
    const root = tempDir();
    const findings = path.join(root, 'findings.json');
    fs.writeFileSync(findings, JSON.stringify({
      runId: FIXTURE_RUN, undispositioned: [], drifts: [],
      sweptRepos: [], failedRepos: [], driftStatus: 'clean',
    }));
    runRunner(runnerEnv(root, findings, {
      OPEN_PR_DIGEST_MAIL_BIN: mailStub(root, path.join(root, 'mail.log')),
    }), ['--dry-run']);
    expect(status(root).status).toBe('ok');
    expect(status(root).routing.skipped).toContain('dry-run');
  });
  it('(19d) A STALE ARTIFACT LEFT IN PLACE IS ALSO findings_unavailable', () => {
    // isla's review of a32fcb1, and her reasoning is better than my test's: mutating to
    // `!dryRun && !routable && !staleFindings` passed 48/48, because (19) covers the MISSING
    // artifact only. A LEFTOVER FILE IS THE LIKELIEST REAL FORM of the failure Codex described
    // -- if the directory became unwritable, yesterday's file is still sitting there -- so the
    // case I did not test is the one most likely to happen.
    const root = tempDir();
    const findings = path.join(root, 'findings.json');
    fs.writeFileSync(findings, JSON.stringify({
      runId: 'yesterday', undispositioned: [], drifts: [],
      sweptRepos: ['tmux-mcc'], failedRepos: [], driftStatus: 'clean', driftProblems: [],
    }));
    runRunnerExpectFail(runnerEnv(root, findings, {
      OPEN_PR_DIGEST_MAIL_BIN: mailStub(root, path.join(root, 'mail.log')),
    }));
    const st = status(root);
    expect(st.status).toBe('fail');
    expect(st.reason).toBe('findings_unavailable');
    expect(st.findingsFresh).toBe(false);
    expect(st.driftStatus).toBe('unknown');        // and the stale 'clean' never surfaces
  });
});
