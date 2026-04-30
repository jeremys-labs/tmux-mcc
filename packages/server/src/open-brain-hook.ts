import process from 'process';
import {
  parseOpenBrainHookArgs,
  runOpenBrainHarnessHook,
} from './services/open-brain-harness-hook.js';

async function readStdinJson(): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  return JSON.parse(text) as Record<string, unknown>;
}

async function main(): Promise<void> {
  const { command, outputFormat } = parseOpenBrainHookArgs(process.argv.slice(2));
  const payload = await readStdinJson();
  const output = await runOpenBrainHarnessHook({ command, outputFormat, payload });
  if (output) process.stdout.write(output);
}

main().catch((error) => {
  console.error(`[open-brain-hook] ${String(error)}`);
  process.exit(1);
});
