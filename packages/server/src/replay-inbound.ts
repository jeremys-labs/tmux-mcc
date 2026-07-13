// CLI: replay a lost inbound Discord message to an agent.
//
//   npm run replay-inbound --workspace=@mcc-tmux/server -- --agent cecelia --message-id 152...
//   npm run replay-inbound --workspace=@mcc-tmux/server -- --agent cecelia --last
//   ... [--force]   (overrides answered/session-active/liveness-unknown; NEVER already_replayed)
//
// Gathers the real state (inbox jsonl, bridge cursor, reconcile breadcrumbs,
// supervisor liveness), asks the pure decision core, and on OK: re-appends the
// original entry with a replayed_from marker, records a fresh inbound-expected
// breadcrumb (so the 7/12 reconciler tracks the replayed expectation too), and
// wakes the agent runtime.

import fs from 'fs';
import path from 'path';
import http from 'http';
import {
  recordInboundExpected,
  readBreadcrumbs,
  inboundExpectedPath,
  outboundSentPath,
  wakeAgentRuntime,
  type InboundExpectedRecord,
  type OutboundSentRecord,
} from '@agent-comms/discord-bridge';
import {
  decideReplay,
  buildReplayEntry,
  parseInboxLines,
  findEntry,
  hasReplayOf,
  type AgentLiveness,
} from './services/inbound-replay.js';

const CONTENT_ROOT = process.env.TMUX_MCC_CONTENT_ROOT ?? path.join(process.env.HOME ?? '', '.tmux-mcc');
const SUPERVISOR = process.env.AGENT_SUPERVISOR_URL ?? 'http://127.0.0.1:4318';

function parseArgs(argv: string[]): { agent?: string; messageId: string | null; last: boolean; force: boolean } {
  const args = { agent: undefined as string | undefined, messageId: null as string | null, last: false, force: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--agent') { args.agent = argv[i + 1]; i += 1; }
    else if (argv[i] === '--message-id') { args.messageId = argv[i + 1]; i += 1; }
    else if (argv[i] === '--last') args.last = true;
    else if (argv[i] === '--force') args.force = true;
  }
  return args;
}

function fetchLiveness(agent: string): Promise<AgentLiveness | null> {
  return new Promise((resolve) => {
    const req = http.get(`${SUPERVISOR}/v1/agents`, { timeout: 5000 }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          const list = Array.isArray(parsed) ? parsed : parsed.agents ?? [];
          const row = list.find((a: { agent?: string }) => a.agent === agent);
          if (!row) { resolve(null); return; }
          resolve({
            processStatus: row.process?.status ?? 'unknown',
            progressStatus: row.progress?.status ?? 'unknown',
          });
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.agent || (!args.messageId && !args.last)) {
    console.error('Usage: replay-inbound --agent <agent> (--message-id <id> | --last) [--force]');
    return 1;
  }

  const inboxPath = path.join(CONTENT_ROOT, 'bridge', 'inbox', `${args.agent}.jsonl`);
  if (!fs.existsSync(inboxPath)) {
    console.error(`no inbox for agent ${args.agent} at ${inboxPath}`);
    return 1;
  }
  const entries = parseInboxLines(fs.readFileSync(inboxPath, 'utf8'));
  const { entry, index } = findEntry(entries, args.last ? null : args.messageId);

  let cursorLineCount = 0;
  try {
    cursorLineCount = (JSON.parse(fs.readFileSync(
      path.join(CONTENT_ROOT, 'bridge', 'runtime-state', `${args.agent}.json`), 'utf8',
    )) as { lineCount?: number }).lineCount ?? 0;
  } catch { /* no cursor = nothing consumed */ }

  const inboundExpected = readBreadcrumbs<InboundExpectedRecord>(inboundExpectedPath(CONTENT_ROOT));
  const queuedAt = entry
    ? inboundExpected.find((r) => r.message_id === entry.id && r.agent === entry.agentKey)?.queued_at ?? null
    : null;
  const outboundSends = readBreadcrumbs<OutboundSentRecord>(outboundSentPath(CONTENT_ROOT));
  const liveness = args.agent ? await fetchLiveness(args.agent) : null;

  const decision = decideReplay({
    entry,
    entryIndex: index,
    cursorLineCount,
    queuedAt,
    outboundSends,
    alreadyReplayed: entry ? hasReplayOf(entries, entry.id) : false,
    liveness,
    force: args.force,
  });

  if (!decision.ok) {
    console.error(`REFUSED (${decision.klass}): ${decision.reason}`);
    return 2;
  }

  const replayEntry = buildReplayEntry(entry!);
  fs.appendFileSync(inboxPath, `${JSON.stringify(replayEntry)}\n`);
  recordInboundExpected(CONTENT_ROOT, {
    queued_at: new Date().toISOString(),
    agent: replayEntry.agentKey,
    chat_id: replayEntry.channelId,
    message_id: replayEntry.id,
    binding: String(replayEntry.bindingName ?? replayEntry.agentKey),
    inbox_path: inboxPath,
  });
  const wake = wakeAgentRuntime(replayEntry.agentKey);
  console.log(JSON.stringify({
    ok: true,
    forced: decision.forced,
    replayed: replayEntry.id,
    agent: replayEntry.agentKey,
    chat_id: replayEntry.channelId,
    wake: wake.attempted ? (wake.ok ? 'ok' : `failed: ${wake.reason}`) : 'skipped',
  }, null, 2));
  return 0;
}

main().then((code) => process.exit(code));
