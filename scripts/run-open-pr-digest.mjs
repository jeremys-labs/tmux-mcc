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
const findingsPath = process.env.OPEN_PR_DIGEST_FINDINGS_PATH
  ?? path.join(os.homedir(), '.tmux-mcc', 'bridge', 'pr-digest', 'open-pr-digest-findings.json');
const notifiedPath = process.env.OPEN_PR_DIGEST_NOTIFIED_PATH
  ?? path.join(os.homedir(), '.tmux-mcc', 'bridge', 'pr-digest', 'open-pr-digest-notified.json');
const mailBin = process.env.OPEN_PR_DIGEST_MAIL_BIN ?? 'agent-mail';
const operator = process.env.OPEN_PR_DIGEST_OPERATOR ?? 'isla';

function run(command, args) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
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

const digest = run('node', [digestScript]);
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
  const sent = run('npm', [
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

const routing = { attempted: 0, delivered: 0, failed: [], unresolvedAuthors: [], notifiedNow: [] };
const findings = readJson(findingsPath, null);
if (findings && Array.isArray(findings.undispositioned)) {
  const open = new Set(findings.undispositioned.map((f) => `${f.repo}#${f.number}`));
  // Bounded relative to its subject: an entry whose PR is no longer undispositioned drops out,
  // so the state cannot grow without limit and cannot name a PR that is gone. Same fix as the
  // surface-check-journal intersection (dc-20261012-007).
  const notified = Object.fromEntries(
    Object.entries(readJson(notifiedPath, {})).filter(([k]) => open.has(k)),
  );
  for (const f of findings.undispositioned) {
    const key = `${f.repo}#${f.number}`;
    if (notified[key]) continue;
    const recipients = [operator];
    if (f.authorAgent && f.authorAgent !== operator) recipients.unshift(f.authorAgent);
    if (!f.authorAgent) routing.unresolvedAuthors.push(key);
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
    let allOk = true;
    for (const to of recipients) {
      routing.attempted += 1;
      if (sendMail(to, `No review verdict after ${f.hoursOpen}h: ${f.repo} #${f.number}`, body)) routing.delivered += 1;
      else { allOk = false; routing.failed.push(`${key} -> ${to}`); }
    }
    try { fs.unlinkSync(body); } catch { /* best-effort */ }
    // ONLY on a fully delivered notification. A PARTIAL send is not a transition and must be
    // re-attempted next run rather than recorded as told.
    if (allOk) { notified[key] = new Date().toISOString(); routing.notifiedNow.push(key); }
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
});

if (dryRun) {
  process.stdout.write(`dry-run: would deliver ${digestText.length} chars to ${chatId}\n`);
}
process.exit(status === 'ok' ? 0 : 1);
