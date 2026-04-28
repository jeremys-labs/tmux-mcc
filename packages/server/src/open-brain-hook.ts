import process from 'process';
import {
  captureClaudeHookEvent,
  formatStartupMemoryForClaude,
  resolveOpenBrainRuntimeConfig,
  searchStartupMemory,
} from './services/open-brain-runtime.js';

function parseArgs(argv: string[]): { command: string } {
  const command = argv[0] ?? '';
  if (!command) throw new Error('Usage: open-brain-hook <session-start|capture>');
  return { command };
}

async function readStdinJson(): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  return JSON.parse(text) as Record<string, unknown>;
}

function inferAgentKey(payload: Record<string, unknown>): string {
  const cwd = typeof payload.cwd === 'string' ? payload.cwd : process.cwd();
  const parts = cwd.split('/').filter(Boolean);
  const agentsIndex = parts.lastIndexOf('agents');
  if (agentsIndex >= 0 && parts[agentsIndex + 1]) return parts[agentsIndex + 1];
  return process.env.AGENT_KEY ?? parts.at(-1) ?? 'unknown';
}

function writeClaudeAdditionalContext(eventName: string, additionalContext: string): void {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: eventName,
      additionalContext,
    },
  }));
}

async function main(): Promise<void> {
  const { command } = parseArgs(process.argv.slice(2));
  const payload = await readStdinJson();
  const agentKey = inferAgentKey(payload);
  const config = resolveOpenBrainRuntimeConfig(agentKey);

  if (command === 'session-start') {
    if (!config) return;
    const memoryText = await searchStartupMemory(config);
    const additionalContext = formatStartupMemoryForClaude(agentKey, memoryText);
    if (additionalContext) writeClaudeAdditionalContext('SessionStart', additionalContext);
    return;
  }

  if (command === 'capture') {
    if (!config) return;
    const eventName = typeof payload.hook_event_name === 'string'
      ? payload.hook_event_name
      : typeof payload.hookEventName === 'string'
        ? payload.hookEventName
        : 'unknown';
    await captureClaudeHookEvent(config, eventName, payload);
    return;
  }

  throw new Error(`Unknown open-brain hook command: ${command}`);
}

main().catch((error) => {
  console.error(`[open-brain-hook] ${String(error)}`);
  process.exit(1);
});
