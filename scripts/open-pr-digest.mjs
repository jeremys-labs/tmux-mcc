#!/usr/bin/env node
// Daily open-PR digest — fleet tune-up pick 2026-07-19 (Isla spec, Jeremy greenlit).
// READ-ONLY: reports open PRs across fleet repos; never merges, labels, or acts.
// Prints the digest to stdout (delivery to #dev is the scheduler/bridge leg).
// Exit codes: 0 = digest printed; 1 = one or more repos failed to sweep
// (partial digest still printed, failures listed) — lets runtime-health alarm.
//
// Flag rules (Isla's, build-to-exactly):
//   ⚠️ security-bearing: title/body/changed paths touch auth, secrets/creds,
//      tokens, public/unauthenticated routes, or .env
//   ⏳ stale: no activity > 7 days
//   🔴 both = top of list
// Sort: flagged first (🔴, ⚠️, ⏳), then oldest. Header: `N open, M flagged`.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';

const REPOS = [
  'jeremys-labs/str-ops',
  'jeremys-labs/tmux-mcc',
  'jeremys-labs/agent-comms',
  'jeremys-labs/agent-supervisor',
  'jeremys-labs/deal-analyzer',
  'jeremys-labs/openclaw-mcc',
  'Med-Aware/myHealthCopilot',
  'Med-Aware/AWS_backend',
];

// Default verdict-holder per repo (Isla's ruling 2026-07-19): whose desk the
// PR sits on — who drives it to merge or escalates, NOT who may merge without
// Jeremy. A live GH review-request/assignee still outranks this map.
const DEFAULT_VERDICT_HOLDERS = {
  'str-ops': 'Marcus',
  'tmux-mcc': 'Eli',
  'agent-comms': 'Eli',
  'agent-supervisor': 'Eli',
  'deal-analyzer': 'Isla',
  'openclaw-mcc': 'Eli',
  myHealthCopilot: 'Marcus',
  AWS_backend: 'Marcus',
};
const FALLBACK_VERDICT_HOLDER = 'Jeremy (unassigned)';

const STALE_DAYS = 7;
const SECURITY_PATTERN =
  /\b(auth|authn|authz|authenticat\w*|unauthenticated|security|secret|credential|token|api ?key|password|permission|public route|allowlist|acl)\b|\.env\b/i;

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// dc-20261021-001. Jeremy rescoped this on 2026-10-29 (Discord 1562338805329961052):
// "Rather than build a new check, just have him extend the one he already has that sends
// me messages", and "I expect us to primarily be running on latest main at all times."
// So this is an EXTENSION of the digest he already reads, not a ninth check.
//
// The two new flags are scoped to AGENT REPOS ONLY. The pre-existing PR listing keeps its
// full eight-repo sweep -- narrowing what Jeremy reads daily is a behaviour change the row
// did not ask for, and "extend, not replace" cuts the other way. Called out in the PR so a
// reviewer can overrule it rather than discover it.
// ---------------------------------------------------------------------------
const AGENT_REPOS = new Set([
  'jeremys-labs/agent-supervisor',
  'jeremys-labs/tmux-mcc',
  'jeremys-labs/agent-comms',
]);

// The LIVE launchd deploy sources. Repo name != directory name for tmux-mcc, which is
// exactly the kind of thing that gets assumed: the GitHub repo is `tmux-mcc` and the
// checkout is `mcc-tmux`.
const CHECKOUT_DIRS = {
  'jeremys-labs/agent-supervisor': 'agent-supervisor',
  'jeremys-labs/tmux-mcc': 'mcc-tmux',
  'jeremys-labs/agent-comms': 'agent-comms',
};

// Seams, env-overridable WITH THE REAL VALUES AS DEFAULTS, so an unset environment is the
// real check and a fixture run is not exercising a lookalike script.
const GH_BIN = process.env.OPEN_PR_DIGEST_GH_BIN ?? 'gh';
const GIT_BIN = process.env.OPEN_PR_DIGEST_GIT_BIN ?? 'git';
const CHECKOUT_ROOT = process.env.OPEN_PR_DIGEST_CHECKOUT_ROOT ?? '/Volumes/Repo-Drive/src';
const ROSTER_PATH = process.env.OPEN_PR_DIGEST_ROSTER
  ?? '/Volumes/Repo-Drive/agents/SHARED/roster.json';
// An injectable clock, because ">24h" is otherwise untestable except by waiting.
const NOW = process.env.OPEN_PR_DIGEST_NOW ? new Date(process.env.OPEN_PR_DIGEST_NOW) : new Date();
const REVIEW_GRACE_HOURS = Number(process.env.OPEN_PR_DIGEST_REVIEW_GRACE_HOURS ?? 24);
// The runner passes the id it will check for. A hand run gets its own, so the artifact always
// carries one and "no runId" can only mean an artifact older than this change.
const RUN_ID = process.env.OPEN_PR_DIGEST_RUN_ID ?? `hand-${Date.now()}-${process.pid}`;
const DRIFT_GRACE_HOURS = Number(process.env.OPEN_PR_DIGEST_DRIFT_GRACE_HOURS ?? 24);

function hoursSince(iso) {
  return (NOW.getTime() - new Date(iso).getTime()) / HOUR_MS;
}

// Agent keys are DERIVED from the roster, never hardcoded here. A second hand-maintained
// roster is the failure that left `DEFAULT_AGENTS` stale by four agents in August; an
// unreadable roster yields an UNRESOLVED author, never a guessed one.
function rosterAgentKeys() {
  try {
    const parsed = JSON.parse(fs.readFileSync(ROSTER_PATH, 'utf8'));
    const keys = (parsed.agents ?? []).map((a) => a.key).filter(Boolean);
    return keys.length > 0 ? new Set(keys) : null;
  } catch {
    return null;
  }
}

// WHY THE BRANCH AND NOT `author.login`: this box has ONE GitHub account, so every PR in
// every fleet repo reports the same author. Measured 2026-10-30 across all open agent-repo
// PRs: 2 of 2 are `jeremylahners`, while their branches are `eli/...` and `marcus/...`.
// Acceptance (5) of the row -- "the finding reaches the author, not only the reader" -- is
// therefore unsatisfiable from `author.login` and keys on the branch prefix instead.
function agentFromBranch(headRefName, agentKeys) {
  const prefix = String(headRefName ?? '').split('/')[0];
  if (!agentKeys) return { agent: null, reason: 'roster unreadable' };
  if (!prefix || !agentKeys.has(prefix)) {
    return { agent: null, reason: `branch "${headRefName ?? '<none>'}" has no roster-agent prefix` };
  }
  return { agent: prefix, reason: null };
}

// THE VERDICT SOURCE (isla's design, PR #42 review blocker 1). `reviewDecision` CANNOT be
// the source: it is `""` on all eight PRs sampled INCLUDING FOUR MERGED ONES, so a detector
// keyed on it can never return a true negative and would flag every non-draft agent PR past
// the grace, forever.
//
// MEASURED ROOT CAUSE, 2026-11-02, and it is sharper than "one account, no branch protection":
// review objects DO exist in this repo, but the only actor creating them is
// `chatgpt-codex-connector[bot]` and it reviews with state `COMMENTED`, which never sets
// `reviewDecision`. So keying on a review's `commit_id` would have live data and would mark a
// PR dispositioned BECAUSE A BOT COMMENTED -- the unsafe direction, and explicitly not a
// rule-11 verdict ("Codex is a bonus, not a dependency").
//
// So the verdict is an explicit comment whose FIRST LINE is `VERDICT: APPROVE|MUST-CHANGE @ <sha>`,
// matched against the CURRENT head.
//
// IT MUST BE THE NEWEST COMMENT WHOSE FIRST LINE MATCHES, NEVER THE NEWEST COMMENT. Verified
// against the real corpus: on #42 the newest comment is the author's DISPOSITIONS, which is not
// a verdict and carries no sha -- taking the newest would read it as the verdict, find no sha,
// and leave the PR PERMANENTLY UNMATCHED. An invented fixture would have had one verdict comment
// and nothing else, and would have hidden this.
//
// FAILS CLOSED on a mistyped sha: a sha that is not the current head simply does not match, so
// the PR stays flagged. The unsafe direction requires typing a sha that happens to equal the
// head while having reviewed something else.
//
// STATED LIMITATION, because the alternative is overclaiming: with one GitHub account every
// comment is `jeremylahners`, so this verifies that A VERDICT EXISTS FOR THIS HEAD, never that
// an INDEPENDENT party rendered it.
const VERDICT_RE = /^VERDICT:\s*(APPROVE|MUST-CHANGE)\s*@\s*([0-9a-f]{7,40})\s*$/;

function latestVerdict(comments) {
  const matches = [...(comments ?? [])]
    .sort((a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')))
    .map((c) => {
      const firstLine = String(c.body ?? '').split(/\r?\n/)[0].trim();
      const m = VERDICT_RE.exec(firstLine);
      return m ? { decision: m[1], sha: m[2], at: c.createdAt ?? null } : null;
    })
    .filter(Boolean);
  return matches.length > 0 ? matches[matches.length - 1] : null;
}

// "verdict for an older head" and "no verdict at all" are DISTINCT findings with distinct
// instructions to the author -- re-review the new head, versus nobody has looked yet.
// Collapsing them tells the author the wrong thing.
function verdictState(comments, headOid) {
  const v = latestVerdict(comments);
  if (!v) return { state: 'missing', verdict: null };
  if (!headOid) return { state: 'cannot-determine', verdict: v };
  return { state: headOid.startsWith(v.sha) ? 'current' : 'stale', verdict: v };
}

const AGENT_REPOS_LIST = [...AGENT_REPOS];
const FINDINGS_PATH = process.env.OPEN_PR_DIGEST_FINDINGS_PATH
  ?? path.join(os.homedir(), '.tmux-mcc', 'bridge', 'pr-digest', 'open-pr-digest-findings.json');

function gh(args) {
  return execFileSync(GH_BIN, args, { encoding: 'utf8', timeout: 60_000 });
}

function git(cwd, args) {
  return execFileSync(GIT_BIN, args, { cwd, encoding: 'utf8', timeout: 60_000 });
}

// For git PREDICATES, where a non-zero exit is the ANSWER and not a failure. execFileSync
// throws on non-zero, so using git() here would turn "no" into an exception.
function spawnOk(cwd, args) {
  return spawnSync(GIT_BIN, args, { cwd, encoding: 'utf8', timeout: 60_000 }).status === 0;
}

// ONE CLOCK (PR #42 review finding 10). This used `Date.now()` while hoursSince() used the
// injectable NOW, so OPEN_PR_DIGEST_NOW moved the new flags and left `stale`, `ageDays` and
// the header's flagged count on the wall clock -- two clocks in one digest.
// One sha, one date. Returns null rather than throwing, because a PR whose head commit cannot
// be read must fall back to a stated basis, not take the sweep down with it.
function headCommitDate(repo, sha) {
  try {
    return gh(['api', `repos/${repo}/commits/${sha}`, '--jq', '.commit.committer.date']).trim() || null;
  } catch {
    return null;
  }
}

function daysSince(iso) {
  return Math.floor((NOW.getTime() - new Date(iso).getTime()) / DAY_MS);
}

function sweepRepo(repo, agentKeys) {
  const raw = gh([
    'pr', 'list', '--repo', repo, '--state', 'open', '--limit', '50',
    // `commits` IS NOT IN THIS LIST AND MUST NOT BE (isla's step-3 review of 02a070f).
    //
    // MEASURED, not reasoned: `commits` at --limit 50 makes gh's GraphQL query request 505,050
    // possible nodes against a hard limit of 500,000, so the call EXITS 1 FOR EVERY REPO. At
    // 02a070f that meant all 8 repos landed in `failures`, `prs` was empty, and the digest
    // Jeremy reads every morning opened with "0 open, 0 flagged" and "No open PRs across fleet
    // repos. 🎉" -- against the 9 open / 7 flagged that origin/main reports. `comments` at the
    // same limit is fine; `commits` is the expensive one, because it returns every commit with
    // its authors when all this needed was ONE DATE FOR ONE SHA.
    //
    // MY ENTIRE 12-MUTATION BATTERY COULD NOT SEE IT, because every test stubs `gh`. That is
    // the same defect as the blocker this PR exists to fix -- validating against a fixture I
    // invented rather than the corpus the code will meet -- and my own rule says it: running
    // inputs you invented is still reading.
    '--json', 'number,title,body,createdAt,updatedAt,reviewDecision,isDraft,reviewRequests,assignees,files,headRefName,headRefOid,comments',
  ]);
  return JSON.parse(raw).map((pr) => {
    const paths = (pr.files ?? []).map((file) => file.path ?? '').join(' ');
    const securityBearing = SECURITY_PATTERN.test(`${pr.title} ${pr.body ?? ''} ${paths}`);
    const stale = daysSince(pr.updatedAt) > STALE_DAYS;
    const reviewers = (pr.reviewRequests ?? []).map((r) => r.login ?? r.name).filter(Boolean);
    const assignees = (pr.assignees ?? []).map((a) => a.login).filter(Boolean);
    const repoName = repo.split('/')[1];
    const verdictHolder =
      reviewers[0] ?? assignees[0] ?? DEFAULT_VERDICT_HOLDERS[repoName] ?? FALLBACK_VERDICT_HOLDER;
    const { agent, reason } = agentFromBranch(pr.headRefName, agentKeys);
    const headOid = pr.headRefOid ?? null;
    const { state: verdict, verdict: verdictComment } = verdictState(pr.comments, headOid);

    // THE GRACE RUNS FROM THE HEAD, NOT FROM `createdAt` (review finding 8). Once the verdict
    // is per-head, a grace measured from PR creation lets a PR re-pushed an hour ago skip the
    // grace entirely on its NEW head -- it is already "5 days old", so the new head is flagged
    // immediately and nobody has had a chance to look at it.
    //
    // BASIS STATED, because this is a claim about time: it is the head commit's COMMITTER date,
    // which is the closest observable proxy for "when this head came to exist" (a rebase or
    // amend updates it). It is NOT the server's receive time, which gh does not expose here,
    // so a rebase that replays genuinely old commits can backdate it. Falls back to
    // `createdAt` when it cannot be read rather than treating the PR as brand new.
    //
    // Fetched LAZILY and ONLY for the PRs that can be flagged, via a REST call for the single
    // head sha. The `commits` field on `pr list` is what blew the GraphQL node limit, and it
    // returned every commit with its authors to answer a question about one.
    const headCommittedIso = (AGENT_REPOS.has(repo) && !pr.isDraft && headOid
      ? headCommitDate(repo, headOid)
      : null) ?? pr.createdAt;
    const hoursSinceHead = hoursSince(headCommittedIso);
    const hoursOpen = hoursSince(pr.createdAt);

    // DRAFTS ARE EXCLUDED: a draft is not asking for a review yet, so flagging it would
    // make the check noise within a week -- and a noisy check earns the right to be ignored.
    const inScope = AGENT_REPOS.has(repo) && !pr.isDraft && hoursSinceHead > REVIEW_GRACE_HOURS;
    const undispositioned = inScope && verdict !== 'current';
    return {
      repo: repoName,
      number: pr.number,
      title: pr.title.length > 60 ? `${pr.title.slice(0, 57)}...` : pr.title,
      ageDays: daysSince(pr.createdAt),
      reviewState: pr.isDraft ? 'draft' : (pr.reviewDecision || 'awaiting-review').toLowerCase(),
      verdictHolder,
      securityBearing,
      stale,
      headRefName: pr.headRefName ?? null,
      headRefOid: headOid,
      hoursOpen: Math.floor(hoursOpen),
      hoursSinceHead: Math.floor(hoursSinceHead),
      verdict,
      verdictSha: verdictComment?.sha ?? null,
      verdictDecision: verdictComment?.decision ?? null,
      undispositioned,
      authorAgent: agent,
      authorUnresolvedReason: agent ? null : reason,
    };
  });
}

function flagIcon(pr) {
  if (pr.securityBearing && pr.stale) return '🔴';
  if (pr.securityBearing) return '⚠️';
  if (pr.stale) return '⏳';
  return '';
}

function flagRank(pr) {
  if (pr.securityBearing && pr.stale) return 0;
  if (pr.securityBearing) return 1;
  if (pr.stale) return 2;
  return 3;
}

// ---------------------------------------------------------------------------
// Flag (b): a live production checkout behind origin/main for more than DRIFT_GRACE_HOURS.
//
// FOUR states, not two. `detached` is its own state on isla's amendment, because it HAPPENED
// in the live agent-supervisor checkout on 2026-10-19 and it is neither at-main nor behind:
// a detached HEAD can be at main's tip and still not be ON main, so the next pull is not a
// fast-forward and `rev-list HEAD..origin/main` can read 0 while the checkout is not tracking
// anything. Collapsing it into either real state is a false reading in one direction or the
// other.
//
// `cannot-determine` IS NEVER CLEAN -- acceptance (4). An unreadable git and a checkout at
// main both produce "no commits behind" from a naive count, and those mean opposite things.
//
// HOW LONG it has been behind is the age of the OLDEST commit HEAD is missing, not the age of
// origin/main's tip: a repo that fell behind a week ago and received a commit a minute ago is
// a week behind, not a minute.
function checkoutDrift(repo) {
  const dir = `${CHECKOUT_ROOT}/${CHECKOUT_DIRS[repo]}`;
  const base = { repo: repo.split('/')[1], dir };
  try {
    if (!fs.existsSync(dir)) {
      return { ...base, state: 'cannot-determine', detail: 'checkout directory absent' };
    }
    git(dir, ['fetch', '--prune', '--quiet', 'origin']);
    // A stale remote-tracking ref makes `HEAD..origin/main` read 0 forever, so the fetch is
    // load-bearing rather than hygiene -- same reason --prune was load-bearing in the drift audit.
    let branch = null;
    try {
      branch = git(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD']).trim();
    } catch {
      branch = null; // detached: symbolic-ref exits non-zero by design
    }
    // --first-parent (review finding 2): without it a merged side branch interleaves by date
    // and "the last line is the oldest" is simply untrue, so the age could come from any
    // commit on any merged branch rather than from the mainline.
    const missing = git(dir, ['log', '--first-parent', '--format=%H %cI', 'HEAD..origin/main']).trim();
    const lines = missing ? missing.split('\n') : [];
    const behindCount = lines.length;
    if (branch === null) {
      return { ...base, state: 'detached', behindCount,
               detail: `HEAD is DETACHED (${behindCount} commit(s) behind origin/main)` };
    }
    // NOT-ON-MAIN IS ITS OWN STATE (review finding 6). `branch` was captured and used only for
    // null-versus-not, so a checkout sitting on `marcus/foo` rebased onto main counted 0
    // commits behind and reported `at-main` WHILE RUNNING UNMERGED CODE -- the same false
    // reading `detached` exists to prevent, one step along.
    if (branch !== 'main') {
      return { ...base, state: 'not-on-main', branch, behindCount,
               detail: `on branch ${branch}, NOT main (${behindCount} commit(s) behind origin/main)` };
    }
    // AHEAD IS NOT AT-MAIN (codex P2 on 02a070f, accepted and reproduced with real git:
    // branch=main, `HEAD..origin/main` = 0, `origin/main..HEAD` = 1).
    //
    // `behindCount` counts only what HEAD is MISSING, so it is 0 when HEAD is level with
    // origin/main AND when it is AHEAD of it. On local `main` with unpushed commits this
    // returned `at-main` and claimed "level with origin/main" about a deploy source RUNNING
    // UNMERGED CODE -- the same false reading `not-on-main` was just added to prevent, for
    // every branch name EXCEPT main itself.
    //
    // That is this row's own recurring class: I fixed the instance (other branch names) and
    // missed the sibling (main, ahead) in the same function in the same commit, which is the
    // 2026-08-03 miss both of today's PRs cite. Caught by a review, not by me.
    const aheadCount = Number(git(dir, ['rev-list', '--count', 'origin/main..HEAD']).trim());
    if (behindCount === 0 && aheadCount > 0) {
      return { ...base, state: 'ahead', branch, behindCount: 0, aheadCount,
               detail: `on ${branch} but ${aheadCount} commit(s) AHEAD of origin/main -- unmerged code is deployed here` };
    }
    if (behindCount > 0 && aheadCount > 0) {
      return { ...base, state: 'diverged', branch, behindCount, aheadCount,
               detail: `on ${branch}, DIVERGED from origin/main (${aheadCount} ahead, ${behindCount} behind)` };
    }
    if (behindCount === 0) {
      return { ...base, state: 'at-main', branch, behindCount: 0, aheadCount: 0,
               detail: `on ${branch}, level with origin/main` };
    }
    const [oldestMissingSha, oldestMissingIso] = lines[lines.length - 1].split(' ');

    // WHEN origin/main MOVED, NOT WHEN THE COMMIT WAS WRITTEN (review finding 2). A commit
    // authored last week and MERGED a minute ago left this reading "a week behind" when the
    // checkout had no opportunity to be stale at all. The reflog of the remote-tracking ref is
    // the only local record of when this checkout learned of the commit.
    //
    // BASIS IS REPORTED, never silently chosen: a fresh clone or a pruned reflog has no entry,
    // and a measurement whose basis is unstated is the defect this whole flag exists to remove.
    let hoursBehind = hoursSince(oldestMissingIso);
    let ageBasis = 'commit-date';
    try {
      const reflog = git(dir, ['reflog', 'show', '--date=iso-strict', '--format=%H %gd',
                               'refs/remotes/origin/main']).trim();
      const entries = reflog ? reflog.split('\n').reverse() : []; // oldest first
      for (const entry of entries.slice(0, 100)) {
        const sha = entry.split(' ')[0];
        const when = (entry.match(/\{([^}]+)\}/) ?? [])[1];
        if (!sha || !when) continue;
        const contains = spawnOk(dir, ['merge-base', '--is-ancestor', oldestMissingSha, sha]);
        if (contains) { hoursBehind = hoursSince(when); ageBasis = 'origin-moved'; break; }
      }
    } catch {
      // No reflog for the remote-tracking ref: keep the commit-date basis and say so.
    }
    return {
      ...base,
      state: 'behind',
      branch,
      behindCount,
      hoursBehind: Math.floor(hoursBehind),
      ageBasis,
      overGrace: hoursBehind > DRIFT_GRACE_HOURS,
      detail: `on ${branch}, ${behindCount} behind origin/main, oldest unmerged commit ${Math.floor(hoursBehind)}h old (basis: ${ageBasis})`,
    };
  } catch (error) {
    return { ...base, state: 'cannot-determine',
             detail: `git unreadable: ${String(error.message ?? error).split('\n')[0]}` };
  }
}

const AGENT_KEYS = rosterAgentKeys();
const prs = [];
const failures = [];
const sweptRepos = [];
for (const repo of REPOS) {
  try {
    prs.push(...sweepRepo(repo, AGENT_KEYS));
    sweptRepos.push(repo.split('/')[1]);
  } catch (error) {
    failures.push(`${repo}: ${String(error.message ?? error).split('\n')[0]}`);
  }
}

prs.sort((a, b) => flagRank(a) - flagRank(b) || b.ageDays - a.ageDays);

const flagged = prs.filter((pr) => flagIcon(pr)).length;
const lines = [
  `**Open-PR digest** — ${prs.length} open, ${flagged} flagged (${new Date().toISOString().slice(0, 10)})`,
  ...prs.map(
    (pr) =>
      `${flagIcon(pr) || '·'} ${pr.repo} #${pr.number} · ${pr.title} · ${pr.ageDays}d · ${pr.reviewState} · verdict-holder: ${pr.verdictHolder}`,
  ),
];
if (prs.length === 0) lines.push('No open PRs across fleet repos. 🎉');

// --- flag (a): agent-repo PRs with no rendered review verdict past the grace -------------
// Appended as its own section rather than folded into flagIcon(), because the header's
// "M flagged" count is DEFINED by flagIcon and Jeremy reads that number daily. Widening what
// it counts would silently change the meaning of a figure already in use.
const undispositioned = prs.filter((pr) => pr.undispositioned);
const noVerdict = undispositioned.filter((pr) => pr.verdict === 'missing' || pr.verdict === 'cannot-determine');
const staleVerdict = undispositioned.filter((pr) => pr.verdict === 'stale');
function authorOf(pr) {
  return pr.authorAgent ?? `UNRESOLVED (${pr.authorUnresolvedReason})`;
}
if (noVerdict.length > 0) {
  lines.push('', `⛔ **No review verdict after ${REVIEW_GRACE_HOURS}h** (agent repos) — ${noVerdict.length}:`);
  for (const pr of noVerdict) {
    lines.push(`   ${pr.repo} #${pr.number} · head ${String(pr.headRefOid ?? '?').slice(0, 12)} · ${pr.hoursSinceHead}h since push · branch ${pr.headRefName ?? '<none>'} · author: ${authorOf(pr)}`);
  }
}
// A verdict that named an EARLIER head is not "nobody looked" -- it is "what was reviewed is
// no longer what is there". Different instruction, so a different section.
if (staleVerdict.length > 0) {
  lines.push('', `🔁 **Verdict is for an OLDER head — re-review needed** (agent repos) — ${staleVerdict.length}:`);
  for (const pr of staleVerdict) {
    lines.push(`   ${pr.repo} #${pr.number} · head ${String(pr.headRefOid ?? '?').slice(0, 12)} · verdict ${pr.verdictDecision} @ ${String(pr.verdictSha).slice(0, 12)} · ${pr.hoursSinceHead}h since push · author: ${authorOf(pr)}`);
  }
}

// --- flag (b): live deploy-source drift ---------------------------------------------------
const drifts = AGENT_REPOS_LIST.map(checkoutDrift);
const driftProblems = drifts.filter(
  (d) => d.state === 'cannot-determine' || d.state === 'detached' || d.state === 'not-on-main'
    || d.state === 'ahead' || d.state === 'diverged'
    || (d.state === 'behind' && d.overGrace),
);
lines.push('', '**Live deploy sources** (agent repos):');
for (const d of drifts) {
  const icon =
    d.state === 'at-main' ? '·'
    : d.state === 'cannot-determine' ? '❓'
    : d.state === 'detached' ? '🔀'
    : d.state === 'not-on-main' ? '🌿'
    : d.state === 'ahead' ? '⏫'
    : d.state === 'diverged' ? '🔱'
    : d.overGrace ? '⛔' : '·';
  lines.push(`   ${icon} ${d.repo}: ${d.state} — ${d.detail}`);
}

if (failures.length > 0) {
  lines.push(`⚠️ sweep failures (${failures.length}): ${failures.join(' | ')}`);
}

// The structured findings the DELIVERY leg routes from. The sweep stays READ-ONLY with
// respect to PRs -- it writes its own artifact and nothing else -- so routing lives in
// run-open-pr-digest.mjs and this script remains safe to run by hand at any time.
// ONE sweep produces both the human text and the routed findings, so the two can never
// disagree about what was observed.
try {
  fs.mkdirSync(path.dirname(FINDINGS_PATH), { recursive: true });
  fs.writeFileSync(FINDINGS_PATH, `${JSON.stringify({
    // RUN ID (review finding 7): the runner matches this against the id IT asked for, so a
    // crashed sweep cannot have yesterday's findings routed and the notified state trimmed
    // against them. An exact match, not a freshness heuristic.
    runId: RUN_ID,
    generatedAtIso: NOW.toISOString(),
    reviewGraceHours: REVIEW_GRACE_HOURS,
    driftGraceHours: DRIFT_GRACE_HOURS,
    rosterReadable: AGENT_KEYS !== null,
    // WHICH REPOS WERE ACTUALLY SWEPT (review finding 4): the runner trims notified state by
    // intersecting with open findings, and intersecting against a repo that FAILED to sweep
    // erases the record for PRs nobody looked at. Same class as the empty-dir guard in
    // surface-check-journal.py, where the guard has to run BEFORE the intersection.
    sweptRepos,
    failedRepos: failures.map((f) => f.split(':')[0]),
    undispositioned,
    drifts,
    // DRIFT GETS ITS OWN STATUS FIELD (review finding 5). Acceptance (4) is that drift never
    // reads as CLEAN -- it is NOT that drift sets the exit code. The exit code is already
    // claimed by "did the job run", so folding drift into it made a finding ABOUT THE REPOS
    // look like the JOB breaking, and a persistently detached checkout would have masked real
    // sweep failures behind a permanent 1.
    driftStatus: driftProblems.length > 0 ? 'problems' : 'clean',
    driftProblems: driftProblems.map((d) => ({ repo: d.repo, state: d.state, detail: d.detail })),
  }, null, 2)}\n`);
} catch (error) {
  lines.push(`⚠️ could not write findings artifact: ${String(error.message ?? error).split('\n')[0]}`);
}

console.log(lines.join('\n'));

// THE EXIT CODE MEANS "DID THE SWEEP RUN" AND NOTHING ELSE (review finding 5).
//
// It used to go non-zero for drift too, on my reading of acceptance (4) that an unanswerable
// check must never read as clean. That acceptance is right and my implementation of it was
// wrong: the exit code was ALREADY claimed by job health, so a drift finding -- a fact about a
// REPO -- rendered as THE JOB BREAKING. Worse, a persistently detached checkout would have
// pinned this at 1 forever and MASKED every real sweep failure behind it.
//
// "Never reads as clean" is satisfied by being present in the digest text AND in `driftStatus`
// in the findings artifact, which is what runtime-health should consume for drift.
process.exit(failures.length > 0 ? 1 : 0);
