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

const STALE_DAYS = 7;
const SECURITY_PATTERN =
  /\b(auth|authn|authz|authenticat\w*|unauthenticated|security|secret|credential|token|api ?key|password|permission|public route|allowlist|acl)\b|\.env\b/i;

const DAY_MS = 24 * 60 * 60 * 1000;

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', timeout: 60_000 });
}

function daysSince(iso) {
  return Math.floor((Date.now() - new Date(iso).getTime()) / DAY_MS);
}

function sweepRepo(repo) {
  const raw = gh([
    'pr', 'list', '--repo', repo, '--state', 'open', '--limit', '50',
    '--json', 'number,title,body,createdAt,updatedAt,reviewDecision,isDraft,reviewRequests,assignees,files',
  ]);
  return JSON.parse(raw).map((pr) => {
    const paths = (pr.files ?? []).map((file) => file.path ?? '').join(' ');
    const securityBearing = SECURITY_PATTERN.test(`${pr.title} ${pr.body ?? ''} ${paths}`);
    const stale = daysSince(pr.updatedAt) > STALE_DAYS;
    const reviewers = (pr.reviewRequests ?? []).map((r) => r.login ?? r.name).filter(Boolean);
    const assignees = (pr.assignees ?? []).map((a) => a.login).filter(Boolean);
    const verdictHolder = reviewers[0] ?? assignees[0] ?? 'unknown';
    return {
      repo: repo.split('/')[1],
      number: pr.number,
      title: pr.title.length > 60 ? `${pr.title.slice(0, 57)}...` : pr.title,
      ageDays: daysSince(pr.createdAt),
      reviewState: pr.isDraft ? 'draft' : (pr.reviewDecision || 'awaiting-review').toLowerCase(),
      verdictHolder,
      securityBearing,
      stale,
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

const prs = [];
const failures = [];
for (const repo of REPOS) {
  try {
    prs.push(...sweepRepo(repo));
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
if (failures.length > 0) {
  lines.push(`⚠️ sweep failures (${failures.length}): ${failures.join(' | ')}`);
}

console.log(lines.join('\n'));
process.exit(failures.length > 0 ? 1 : 0);
