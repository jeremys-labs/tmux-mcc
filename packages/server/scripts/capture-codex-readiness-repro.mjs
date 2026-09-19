import crypto from 'node:crypto';
import fs from 'node:fs';
import process from 'node:process';
import { createRequire } from 'node:module';

const requireFromRepo = createRequire(new URL('../../../package.json', import.meta.url));
const pty = requireFromRepo('node-pty');

const [outputPath, readyPath, workspace] = process.argv.slice(2);
if (!outputPath || !readyPath || !workspace) {
  throw new Error('usage: capture-codex-readiness-repro.mjs OUTPUT_JSON READY_FILE WORKSPACE');
}

const prompt = 'Reply with exactly CODEX_READINESS_CAPTURE_DONE_20260904 and no other text. Do not use tools.';
const chunks = [];
const startedAt = process.hrtime.bigint();
let sequence = 0;
let submitted = false;
let markerObserved = false;
let afterMarker = '';
let settleTimer;

const childEnv = { ...process.env };
for (const key of ['CODEX_CI', 'CODEX_SESSION_ID', 'CODEX_THREAD_ID', 'NO_COLOR']) {
  delete childEnv[key];
}

function stripAnsi(value) {
  return value.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

function persist() {
  const record = {
    schemaVersion: 1,
    captureKind: 'node-pty-onData',
    codexVersion: '0.151.0',
    terminal: { name: 'xterm-256color', cols: 120, rows: 40, noAltScreen: true },
    prompt,
    chunks,
  };
  fs.writeFileSync(outputPath, `${JSON.stringify(record, null, 2)}\n`);
}

function submitPrompt() {
  if (submitted) return;
  submitted = true;
  term.write(prompt);
  setTimeout(() => term.write('\r'), 150);
}

const term = pty.spawn('codex', [
  '--no-alt-screen',
  '--ask-for-approval', 'never',
  '--sandbox', 'read-only',
  '--dangerously-bypass-hook-trust',
  '-c', 'check_for_update_on_startup=false',
], {
  name: 'xterm-256color',
  cols: 120,
  rows: 40,
  cwd: workspace,
  env: childEnv,
});

term.onData((data) => {
  const bytes = Buffer.from(data, 'utf8');
  chunks.push({
    sequence,
    elapsedNs: Number(process.hrtime.bigint() - startedAt),
    byteLength: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    dataBase64: bytes.toString('base64'),
  });
  sequence += 1;
  process.stdout.write(data);

  const text = stripAnsi(data);
  if (!submitted) {
    if (text.includes('\n› ') || text.startsWith('› ')) {
      submitPrompt();
    }
    return;
  }

  if (markerObserved) afterMarker += text;
  if (text.includes('CODEX_READINESS_CAPTURE_DONE_20260904')) {
    markerObserved = true;
    afterMarker += text.slice(text.indexOf('CODEX_READINESS_CAPTURE_DONE_20260904'));
  }

  if (markerObserved && (afterMarker.includes('\n› ') || afterMarker.startsWith('› '))) {
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      persist();
      fs.writeFileSync(readyPath, 'captured\n');
    }, 1500);
  }
});

term.onExit(({ exitCode, signal }) => {
  persist();
  if (!fs.existsSync(readyPath)) fs.writeFileSync(readyPath, `exited ${exitCode} ${signal}\n`);
  process.exit(exitCode ?? 1);
});

if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on('data', (data) => term.write(data.toString()));

// Submission must not depend on the detector under test. Current Codex can render a
// visible prompt without placing the glyph in one callback, which is the failure being
// reproduced. The bounded timer lets startup settle, then drives the controlled turn.
setTimeout(submitPrompt, 20_000);

function stop() {
  clearTimeout(settleTimer);
  persist();
  term.kill();
}

process.on('SIGINT', stop);
process.on('SIGTERM', stop);
