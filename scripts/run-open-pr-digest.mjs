#!/usr/bin/env node
// Runs the read-only open-PR digest, delivers the digest through the server-side
// Discord bridge, and writes a status artifact for runtime-health.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const digestScript = process.env.OPEN_PR_DIGEST_SCRIPT ?? path.join(repoRoot, 'scripts', 'open-pr-digest.mjs');
const statusPath = process.env.OPEN_PR_DIGEST_STATUS_PATH
  ?? path.join(os.homedir(), '.tmux-mcc', 'bridge', 'pr-digest', 'open-pr-digest-status.json');
const chatId = process.env.OPEN_PR_DIGEST_CHAT_ID ?? '1492892431543308439';
const agent = process.env.OPEN_PR_DIGEST_AGENT ?? 'marcus';
const jobId = process.env.SCHEDULED_JOB_ID ?? process.env.OPEN_PR_DIGEST_JOB_ID ?? 'open-pr-digest-daily';
const label = process.env.SCHEDULED_JOB_LABEL ?? process.env.OPEN_PR_DIGEST_LABEL ?? 'Daily open-PR digest';
const dryRun = process.argv.includes('--dry-run') || process.env.OPEN_PR_DIGEST_DRY_RUN === '1';
// THE FRESHNESS CHECK IS AN EXACT MATCH, NOT A TIMESTAMP WINDOW (review finding 7). The runner
// mints the id, hands it to the sweep, and refuses to route anything unless the artifact comes
// back carrying that id. A sweep that crashed before writing leaves YESTERDAY's findings on
// disk, and routing those would mail authors about PRs nobody looked at today AND trim the
// notified state against them.
const runId = process.env.OPEN_PR_DIGEST_RUN_ID
  ?? `run-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
const findingsPath = process.env.OPEN_PR_DIGEST_FINDINGS_PATH
  ?? path.join(os.homedir(), '.tmux-mcc', 'bridge', 'pr-digest', 'open-pr-digest-findings.json');
const notifiedPath = process.env.OPEN_PR_DIGEST_NOTIFIED_PATH
  ?? path.join(os.homedir(), '.tmux-mcc', 'bridge', 'pr-digest', 'open-pr-digest-notified.json');
const mailBin = process.env.OPEN_PR_DIGEST_MAIL_BIN ?? 'agent-mail';
// A DELIVERY SEAM, real value as the default. Without it the ONLY way a test could reach the
// routing leg was --dry-run, because the delivery leg shells out to the real Discord bridge --
// which is exactly why --dry-run grew a routing side effect and why my own test (5) asserted
// mail was sent under it. The missing seam is the cause of the defect, not just of the gap in
// the control.
const deliverBin = process.env.OPEN_PR_DIGEST_DELIVER_BIN ?? 'npm';
const operator = process.env.OPEN_PR_DIGEST_OPERATOR ?? 'isla';

function run(command, args, extraEnv) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    ...(extraEnv ? { env: { ...process.env, ...extraEnv } } : {}),
  });
}

function writeStatus(status) {
  fs.mkdirSync(path.dirname(statusPath), { recursive: true });
  fs.writeFileSync(statusPath, `${JSON.stringify(status, null, 2)}\n`);
}

function baseStatus() {
  return {
    runAtIso: new Date().toISOString(),
    jobId,
    label,
    chatId,
    agent,
    digestScript,
  };
}

const digest = run('node', [digestScript], { OPEN_PR_DIGEST_RUN_ID: runId });
let digestText = digest.stdout || '';
if (!digestText.trim()) {
  digestText = [
    `**Open-PR digest** — sweep produced no output (${new Date().toISOString().slice(0, 10)})`,
    `⚠️ sweep failed before producing a digest; exit=${digest.status ?? 'signal'} ${digest.stderr?.trim() ?? ''}`.trim(),
  ].join('\n');
}

const tempTextFile = path.join(os.tmpdir(), `open-pr-digest-${process.pid}.md`);
fs.writeFileSync(tempTextFile, digestText);

let delivery = { ok: false, id: undefined, raw: '' };
let deliveryError = '';
if (dryRun) {
  delivery = { ok: true, id: 'dry-run', raw: '{"ok":true,"id":"dry-run"}' };
} else {
  const sent = run(deliverBin, [
    'run', 'discord:reply',
    '--workspace=@mcc-tmux/server',
    '--prefix', repoRoot,
    '--',
    '--agent', agent,
    '--chat-id', chatId,
    '--text-file', tempTextFile,
    '--source', 'scheduled_runtime',
    '--job-id', jobId,
    '--label', label,
  ]);
  delivery.raw = sent.stdout || sent.stderr || '';
  if (sent.status === 0) {
    try {
      const lines = delivery.raw.trim().split(/\r?\n/).filter(Boolean);
      const parsed = JSON.parse(lines[lines.length - 1] ?? '{}');
      delivery = { ok: Boolean(parsed.ok), id: parsed.id, raw: delivery.raw };
    } catch (error) {
      deliveryError = `bridge response parse failed: ${String(error)}`;
    }
  } else {
    deliveryError = `bridge send exited ${sent.status ?? 'signal'}: ${(sent.stderr || sent.stdout || '').trim()}`;
  }
}

try {
  fs.unlinkSync(tempTextFile);
} catch {
  // Best-effort temp cleanup.
}

// ---------------------------------------------------------------------------
// dc-20261021-001 acceptance (5): THE FINDING REACHES THE AUTHOR, NOT ONLY THE READER.
// The digest goes to Jeremy's DM, so without this leg an unreviewed PR is visible only to the
// one person who does not review it. Routing lives HERE rather than in the sweep so the sweep
// stays read-only and safe to run by hand at any time.
//
// TRANSITION-ONLY, AND STATE ADVANCES ONLY ON DELIVERY -- the exact shape Zara made me fix on
// dc-20261015-002, where alert() returned false and the new state was written anyway, losing
// the transition permanently. A daily re-ping is also how a signal earns the right to be
// ignored: the author needs to LEARN of it once, and Jeremy's digest already carries the
// standing list every morning.
function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function sendMail(to, subject, bodyFile) {
  return run(mailBin, [
    'send', '--from', agent, '--to', to, '--type', 'note',
    '--subject', subject, '--body-file', bodyFile,
  ]).status === 0;
}

const routing = {
  attempted: 0, delivered: 0, failed: [], unresolvedAuthors: [], notifiedNow: [],
  skipped: undefined,
};
const findings = readJson(findingsPath, null);

// --dry-run MUST NOT ACT (review finding 3). It skipped Discord and then sent REAL agent-mail
// and wrote notified.json, so a rehearsal mailed people and -- worse -- recorded them as told,
// which SUPPRESSES the real notification on the next run. My own test (5) ran with --dry-run
// and asserted mail WAS sent, so the control pinned the defect in place as intended behaviour.
const staleFindings = findings && findings.runId !== runId;
const routable = findings && Array.isArray(findings.undispositioned) && !dryRun && !staleFindings;
if (dryRun) routing.skipped = 'dry-run: no mail sent, no state written';
else if (staleFindings) {
  routing.skipped = `findings artifact is from another run (want ${runId}, got ${findings.runId ?? '<none>'})`;
}

if (routable) {
  const open = new Set(findings.undispositioned.map((f) => `${f.repo}#${f.number}`));
  // TRIM ONLY WHAT WAS ACTUALLY SWEPT (review finding 4). The intersection bounds the state
  // against its subject, but intersecting against a repo that FAILED to sweep erases the
  // record for PRs nobody looked at -- and the author is then re-mailed about a PR they were
  // already told about. Same class as the empty-dir guard in surface-check-journal.py, where
  // I documented that the guard must run BEFORE the intersection and then did not apply it here.
  //
  // THE GUARD RUNS FIRST: with no swept-repo list (an older artifact) nothing is trimmed at all,
  // because "I cannot tell what was swept" must not mean "assume everything was".
  const swept = Array.isArray(findings.sweptRepos) ? new Set(findings.sweptRepos) : null;
  const notified = Object.fromEntries(
    Object.entries(readJson(notifiedPath, {})).filter(([k]) => {
      if (open.has(k)) return true;
      if (!swept) return true;
      return !swept.has(k.split('#')[0]);
    }),
  );
  for (const f of findings.undispositioned) {
    const key = `${f.repo}#${f.number}`;
    const recipients = [operator];
    if (f.authorAgent && f.authorAgent !== operator) recipients.unshift(f.authorAgent);
    if (!f.authorAgent) routing.unresolvedAuthors.push(key);
    // PER-RECIPIENT (review finding 9). `allOk` was my fix for Zara's dc-20261015-002 point
    // that state must advance only on delivery, and I overcorrected: with two recipients, a
    // PERSISTENT failure to one re-mails the OTHER every single day. Each recipient's delivery
    // is its own transition.
    const already = notified[key] && typeof notified[key] === 'object' ? { ...notified[key] } : {};
    const pending = recipients.filter((to) => !already[to]);
    if (pending.length === 0) continue;
    const body = path.join(os.tmpdir(), `pr-unreviewed-${f.repo}-${f.number}.md`);
    fs.writeFileSync(body, [
      `**${f.repo} #${f.number} has had no review verdict for ${f.hoursOpen}h.**`,
      '',
      `Branch \`${f.headRefName ?? '<none>'}\`, review state \`${f.reviewState}\`.`,
      f.authorAgent
        ? `Routed to you as the branch-prefix author, and to ${operator}.`
        : `AUTHOR COULD NOT BE RESOLVED (${f.authorUnresolvedReason}), so this reached ${operator} only.`,
      '',
      'Nothing merges on an unread or un-dispositioned review. Either get a verdict on the exact',
      'head, or close the PR if it is abandoned.',
      '',
      '_Automated: open-PR digest, dc-20261021-001. Once per PR, not daily._',
    ].join('\n'));
    for (const to of pending) {
      routing.attempted += 1;
      if (sendMail(to, `No review verdict after ${f.hoursSinceHead ?? f.hoursOpen}h: ${f.repo} #${f.number}`, body)) {
        routing.delivered += 1;
        // Recorded per recipient, so a failure to one never re-mails the other.
        already[to] = new Date().toISOString();
        routing.notifiedNow.push(`${key} -> ${to}`);
      } else {
        routing.failed.push(`${key} -> ${to}`);
      }
    }
    try { fs.unlinkSync(body); } catch { /* best-effort */ }
    if (Object.keys(already).length > 0) notified[key] = already;
  }
  try {
    fs.mkdirSync(path.dirname(notifiedPath), { recursive: true });
    fs.writeFileSync(notifiedPath, `${JSON.stringify(notified, null, 2)}\n`);
  } catch (error) {
    routing.failed.push(`state write: ${String(error.message ?? error).split('\n')[0]}`);
  }
}

const sweepExitCode = digest.status ?? 1;
const deliveryOk = delivery.ok === true;
const status =
  !deliveryOk ? 'fail'
  : sweepExitCode === 0 ? 'ok'
  : 'fail';
const reason =
  !deliveryOk ? 'delivery_failed'
  : sweepExitCode === 0 ? 'sweep_ok'
  : 'partial_failure';

writeStatus({
  ...baseStatus(),
  status,
  reason,
  sweepExitCode,
  deliveryOk,
  deliveryMessageId: delivery.id,
  digestChars: digestText.length,
  stderr: digest.stderr?.trim() || undefined,
  deliveryError: deliveryError || undefined,
  dryRun,
  routing,
  // DRIFT'S OWN SURFACE (review finding 5). The sweep's exit code now means "did the sweep
  // run", so drift needs a field of its own or acceptance (4) -- drift never reads as clean --
  // would be lost rather than re-expressed. runtime-health consumes THIS for drift, and the
  // exit code for job health. Unknown when the artifact could not be read, never 'clean'.
  driftStatus: findings?.driftStatus ?? 'unknown',
  driftProblems: findings?.driftProblems ?? undefined,
  findingsRunId: findings?.runId ?? undefined,
  findingsFresh: findings ? findings.runId === runId : undefined,
});

if (dryRun) {
  process.stdout.write(`dry-run: would deliver ${digestText.length} chars to ${chatId}\n`);
}
process.exit(status === 'ok' ? 0 : 1);
