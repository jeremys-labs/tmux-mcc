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
import { execFileSync } from 'node:child_process';

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

// A RENDERED REVIEW VERDICT, which is narrower than rule 11's "dispositioned" and is
// deliberately the observable thing. gh exposes reviewDecision; it CANNOT tell us whether
// each finding got a written disposition in prose, and recovering that from comment text
// would be an unsound text predicate. Stated as a boundary rather than overclaimed: this
// flags the ABSENCE OF A VERDICT, not the absence of a disposition.
const DISPOSITIONED = new Set(['approved', 'changes_requested']);

const AGENT_REPOS_LIST = [...AGENT_REPOS];
const FINDINGS_PATH = process.env.OPEN_PR_DIGEST_FINDINGS_PATH
  ?? path.join(os.homedir(), '.tmux-mcc', 'bridge', 'pr-digest', 'open-pr-digest-findings.json');

function gh(args) {
  return execFileSync(GH_BIN, args, { encoding: 'utf8', timeout: 60_000 });
}

function git(cwd, args) {
  return execFileSync(GIT_BIN, args, { cwd, encoding: 'utf8', timeout: 60_000 });
}

function daysSince(iso) {
  return Math.floor((Date.now() - new Date(iso).getTime()) / DAY_MS);
}

function sweepRepo(repo, agentKeys) {
  const raw = gh([
    'pr', 'list', '--repo', repo, '--state', 'open', '--limit', '50',
    '--json', 'number,title,body,createdAt,updatedAt,reviewDecision,isDraft,reviewRequests,assignees,files,headRefName',
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
    const decision = (pr.reviewDecision || '').toLowerCase();
    const hoursOpen = hoursSince(pr.createdAt);
    const { agent, reason } = agentFromBranch(pr.headRefName, agentKeys);
    // DRAFTS ARE EXCLUDED: a draft is not asking for a review yet, so flagging it would
    // make the check noise within a week -- and a noisy check earns the right to be ignored.
    const undispositioned =
      AGENT_REPOS.has(repo) && !pr.isDraft && !DISPOSITIONED.has(decision) && hoursOpen > REVIEW_GRACE_HOURS;
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
      hoursOpen: Math.floor(hoursOpen),
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
    const missing = git(dir, ['log', '--format=%cI', 'HEAD..origin/main']).trim();
    const lines = missing ? missing.split('\n') : [];
    const behindCount = lines.length;
    if (branch === null) {
      return { ...base, state: 'detached', behindCount,
               detail: `HEAD is DETACHED (${behindCount} commit(s) behind origin/main)` };
    }
    if (behindCount === 0) {
      return { ...base, state: 'at-main', behindCount: 0, detail: `on ${branch}, level with origin/main` };
    }
    const oldestMissingIso = lines[lines.length - 1];
    const hoursBehind = hoursSince(oldestMissingIso);
    return {
      ...base,
      state: 'behind',
      behindCount,
      hoursBehind: Math.floor(hoursBehind),
      overGrace: hoursBehind > DRIFT_GRACE_HOURS,
      detail: `on ${branch}, ${behindCount} behind origin/main, oldest unmerged commit ${Math.floor(hoursBehind)}h old`,
    };
  } catch (error) {
    return { ...base, state: 'cannot-determine',
             detail: `git unreadable: ${String(error.message ?? error).split('\n')[0]}` };
  }
}

const AGENT_KEYS = rosterAgentKeys();
const prs = [];
const failures = [];
for (const repo of REPOS) {
  try {
    prs.push(...sweepRepo(repo, AGENT_KEYS));
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
if (undispositioned.length > 0) {
  lines.push('', `⛔ **No review verdict after ${REVIEW_GRACE_HOURS}h** (agent repos) — ${undispositioned.length}:`);
  for (const pr of undispositioned) {
    const who = pr.authorAgent ?? `UNRESOLVED (${pr.authorUnresolvedReason})`;
    lines.push(`   ${pr.repo} #${pr.number} · ${pr.hoursOpen}h open · ${pr.reviewState} · branch ${pr.headRefName ?? '<none>'} · author: ${who}`);
  }
}

// --- flag (b): live deploy-source drift ---------------------------------------------------
const drifts = AGENT_REPOS_LIST.map(checkoutDrift);
const driftProblems = drifts.filter(
  (d) => d.state === 'cannot-determine' || d.state === 'detached' || (d.state === 'behind' && d.overGrace),
);
lines.push('', '**Live deploy sources** (agent repos):');
for (const d of drifts) {
  const icon =
    d.state === 'at-main' ? '·'
    : d.state === 'cannot-determine' ? '❓'
    : d.state === 'detached' ? '🔀'
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
    generatedAtIso: NOW.toISOString(),
    reviewGraceHours: REVIEW_GRACE_HOURS,
    driftGraceHours: DRIFT_GRACE_HOURS,
    rosterReadable: AGENT_KEYS !== null,
    undispositioned,
    drifts,
  }, null, 2)}\n`);
} catch (error) {
  lines.push(`⚠️ could not write findings artifact: ${String(error.message ?? error).split('\n')[0]}`);
}

console.log(lines.join('\n'));

// EXIT 1 ALSO FOR cannot-determine AND detached, not only for sweep failures. Acceptance (4)
// is that an unanswerable check never reads as clean, and the exit code is what runtime-health
// consumes -- a digest that printed "❓ could not read git" and exited 0 would be exactly the
// vacuous pass this row exists to prevent.
process.exit(failures.length > 0 || driftProblems.length > 0 ? 1 : 0);
