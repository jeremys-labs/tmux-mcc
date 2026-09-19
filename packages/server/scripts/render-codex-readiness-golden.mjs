import crypto from 'node:crypto';
import fs from 'node:fs';
import process from 'node:process';
import { createRequire } from 'node:module';

const [fixturePath, outputPath] = process.argv.slice(2);
if (!fixturePath || !outputPath) {
  throw new Error('usage: render-codex-readiness-golden.mjs FIXTURE_JSON OUTPUT_JSON');
}

const requireFromRepo = createRequire(new URL('../../../package.json', import.meta.url));
const { Terminal } = requireFromRepo('@xterm/headless');
const rendererPackage = requireFromRepo('@xterm/headless/package.json');
const fixtureBytes = fs.readFileSync(fixturePath);
const fixture = JSON.parse(fixtureBytes.toString('utf8'));
const options = {
  cols: fixture.terminal.cols,
  rows: fixture.terminal.rows,
  scrollback: 1_000,
  allowProposedApi: true,
};
const terminal = new Terminal(options);

for (const chunk of fixture.chunks) {
  const bytes = Buffer.from(chunk.dataBase64, 'base64');
  await new Promise((resolve) => terminal.write(bytes, resolve));
}

const buffer = terminal.buffer.active;
const lines = [];
for (let row = 0; row < terminal.rows; row += 1) {
  lines.push(buffer.getLine(buffer.viewportY + row)?.translateToString(false) ?? ''.padEnd(terminal.cols));
}

const golden = {
  schemaVersion: 1,
  renderer: {
    package: '@xterm/headless',
    version: rendererPackage.version,
    options,
  },
  source: {
    fixtureSha256: crypto.createHash('sha256').update(fixtureBytes).digest('hex'),
    captureTimestamp: fixture.capturedAt,
    callbackCount: fixture.chunks.length,
    streamSha256: fixture.sanitization.sanitizedStreamSha256,
  },
  viewport: {
    baseY: buffer.baseY,
    viewportY: buffer.viewportY,
    cursorX: buffer.cursorX,
    cursorY: buffer.cursorY,
    lines,
  },
};

terminal.dispose();
fs.writeFileSync(outputPath, `${JSON.stringify(golden, null, 2)}\n`);
