import crypto from 'node:crypto';
import fs from 'node:fs';
import process from 'node:process';

const [inputPath, outputPath, ...redactLiterals] = process.argv.slice(2);
if (!inputPath || !outputPath) {
  throw new Error('usage: sanitize-codex-readiness-capture.mjs INPUT OUTPUT [LITERAL ...]');
}

const capture = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
capture.capturedAt ??= fs.statSync(inputPath).mtime.toISOString();
const lengths = capture.chunks.map((chunk) => chunk.byteLength);
const original = Buffer.concat(capture.chunks.map((chunk) => Buffer.from(chunk.dataBase64, 'base64')));
const sanitized = Buffer.from(original);
const redactions = [];

for (const literal of redactLiterals) {
  const needle = Buffer.from(literal, 'utf8');
  if (needle.length === 0) continue;
  let occurrences = 0;
  let offset = 0;
  while ((offset = sanitized.indexOf(needle, offset)) !== -1) {
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

let cursor = 0;
capture.chunks = capture.chunks.map((chunk, sequence) => {
  const bytes = sanitized.subarray(cursor, cursor + lengths[sequence]);
  cursor += lengths[sequence];
  return {
    ...chunk,
    sequence,
    byteLength: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    dataBase64: bytes.toString('base64'),
  };
});
capture.sanitization = {
  algorithm: 'equal-byte replacement over concatenated stream before restoring original boundaries',
  originalStreamSha256: crypto.createHash('sha256').update(original).digest('hex'),
  sanitizedStreamSha256: crypto.createHash('sha256').update(sanitized).digest('hex'),
  originalByteLength: original.length,
  sanitizedByteLength: sanitized.length,
  redactions,
};

fs.writeFileSync(outputPath, `${JSON.stringify(capture, null, 2)}\n`);
