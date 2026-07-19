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
});

if (dryRun) {
  process.stdout.write(`dry-run: would deliver ${digestText.length} chars to ${chatId}\n`);
}
process.exit(status === 'ok' ? 0 : 1);
