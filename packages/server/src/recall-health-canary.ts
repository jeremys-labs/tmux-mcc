import fs from 'fs';
import { runRecallCanary } from './services/recall-health-canary.js';

// CLI entrypoint for the recall health canary. Prints the single status line to
// stdout and, with --out <path>, writes it to a file for the delivery step to
// post to #hq. Always exits 0 — the posted LINE is the signal, not the exit code,
// so the scheduled delivery step runs whether the fleet is healthy or blind.
function parseOut(argv: string[]): string | undefined {
  const index = argv.indexOf('--out');
  return index >= 0 ? argv[index + 1] : undefined;
}

const outPath = parseOut(process.argv.slice(2));

runRecallCanary({
  agentsRoot: process.env.AGENTS_ROOT,
  serviceUrl: process.env.AGENT_MEMORY_SERVICE_URL,
})
  .then(({ line }) => {
    process.stdout.write(`${line}\n`);
    if (outPath) fs.writeFileSync(outPath, `${line}\n`);
    process.exit(0);
  })
  .catch((error) => {
    // Never throw — emit a blind-style line so the delivery step still posts.
    const line = `⚠️ recall canary failed to run: ${String(error).slice(0, 160)}`;
    process.stdout.write(`${line}\n`);
    if (outPath) fs.writeFileSync(outPath, `${line}\n`);
    process.exit(0);
  });
