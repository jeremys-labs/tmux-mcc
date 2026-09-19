import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const [rolloutPath, ordinalText, outputPath, ...redactLiterals] = process.argv.slice(2);
if (!rolloutPath || !ordinalText || !outputPath) {
  throw new Error('usage: extract-codex-tmux-oracle.mjs ROLLOUT_JSONL ORDINAL OUTPUT_JSON [LITERAL ...]');
}

const ordinal = Number(ordinalText);
const records = fs.readFileSync(rolloutPath, 'utf8').split('\n').filter(Boolean);
const matches = records
  .map((line) => ({ line, record: JSON.parse(line) }))
  .filter(({ record }) => record.ordinal === ordinal);
if (matches.length !== 1) throw new Error(`expected one rollout record at ordinal ${ordinal}, found ${matches.length}`);

const { line: sourceLine, record } = matches[0];
const item = record.payload?.item;
if (item?.type !== 'CommandExecution' || !Array.isArray(item.command) || typeof item.stdout !== 'string') {
  throw new Error(`ordinal ${ordinal} is not a command execution with stdout`);
}
if (!item.command.join(' ').includes('tmux capture-pane') || !item.stdout.includes('CODEX_READINESS_CAPTURE_DONE_20260904')) {
  throw new Error(`ordinal ${ordinal} is not the expected tmux readiness capture`);
}

const raw = Buffer.from(item.stdout, 'utf8');
const sanitized = Buffer.from(raw);
const redactions = [];
for (const literal of redactLiterals) {
  const needle = Buffer.from(literal, 'utf8');
  let occurrences = 0;
  let offset = 0;
  while (needle.length > 0 && (offset = sanitized.indexOf(needle, offset)) !== -1) {
    sanitized.fill(0x78, offset, offset + needle.length);
    offset += needle.length;
    occurrences += 1;
  }
  redactions.push({
    literalSha256: crypto.createHash('sha256').update(needle).digest('hex'),
    byteLength: needle.length,
    occurrences,
    replacementByte: '0x78',
  });
}

const screenText = sanitized.toString('utf8');
const lines = (screenText.endsWith('\n') ? screenText.slice(0, -1) : screenText).split('\n');
if (lines.length !== 40 || Math.max(...lines.map((line) => [...line].length)) > 120) {
  throw new Error(`expected a 120x40 tmux capture, got ${lines.length} rows`);
}

const oracle = {
  schemaVersion: 1,
  source: {
    rolloutBasename: path.basename(rolloutPath),
    rolloutOrdinal: ordinal,
    eventTimestamp: record.timestamp,
    eventRecordSha256: crypto.createHash('sha256').update(sourceLine).digest('hex'),
    command: item.command,
  },
  sanitization: {
    algorithm: 'equal-byte replacement in captured stdout',
    rawScreenSha256: crypto.createHash('sha256').update(raw).digest('hex'),
    sanitizedScreenSha256: crypto.createHash('sha256').update(sanitized).digest('hex'),
    redactions,
  },
  screen: { cols: 120, rows: 40, lines },
};

fs.writeFileSync(outputPath, `${JSON.stringify(oracle, null, 2)}\n`);
