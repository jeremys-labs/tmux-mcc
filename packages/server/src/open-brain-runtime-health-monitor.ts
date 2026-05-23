import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {
  buildRuntimeHealthReport,
  type AgentRuntimeHealth,
  type RuntimeHealthReport,
} from './services/runtime-health.js';

const DEFAULT_CHAT_ID = '1491979880747765810';
const DEFAULT_AGENT = 'eli';
const DEFAULT_STATE_PATH = '/Users/jeremylahners/.tmux-mcc/open-brain/runtime-health-monitor-state.json';

interface MonitorState {
  lastFingerprint?: string;
  lastSentAt?: string;
}

function readArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function readMonitorState(filePath: string): MonitorState {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as MonitorState;
  } catch {
    return {};
  }
}

function writeMonitorState(filePath: string, state: MonitorState): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`);
}

export function findDeliveryFailures(report: RuntimeHealthReport): AgentRuntimeHealth[] {
  return report.agents.filter((agent) => agent.discordInboxDelivery.status === 'error');
}

export function deliveryFailureFingerprint(failures: AgentRuntimeHealth[]): string {
  return failures
    .map((agent) => `${agent.agent}:${agent.discordInboxDelivery.detail}`)
    .sort()
    .join('|');
}

export function formatDeliveryFailureAlert(report: RuntimeHealthReport): string {
  const failures = findDeliveryFailures(report);
  const lines = [
    `Runtime delivery verification failed at ${report.generatedAtIso}.`,
    '',
    'Discord inbox messages are queued but have not crossed the runtime delivery cursor.',
    '',
    ...failures.slice(0, 10).map((agent) => `- ${agent.agent}: ${agent.discordInboxDelivery.detail}`),
  ];
  if (failures.length > 10) lines.push(`- ...and ${failures.length - 10} more agent(s).`);
  lines.push('');
  lines.push('Action: inspect the affected runtime pane/wrapper before claiming Discord delivery is healthy.');
  return lines.join('\n');
}

async function sendDiscordMessage(input: {
  agent: string;
  chatId: string;
  text: string;
  socketPath: string;
}): Promise<string> {
  const payload = JSON.stringify({
    agentKey: input.agent,
    chat_id: input.chatId,
    text: input.text,
  });
  return new Promise<string>((resolve, reject) => {
    const request = http.request({
      socketPath: input.socketPath,
      path: '/send',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        if ((response.statusCode ?? 500) < 200 || (response.statusCode ?? 500) >= 300) {
          reject(new Error(body));
          return;
        }
        resolve(body);
      });
    });
    request.on('error', reject);
    request.end(payload);
  });
}

async function main(): Promise<void> {
  const statePath = readArg('--state-path') ?? DEFAULT_STATE_PATH;
  const socketPath = readArg('--socket-path') ?? process.env.DISCORD_BRIDGE_SOCKET_PATH ?? '/tmp/agent-discord-bridge.sock';
  const chatId = readArg('--chat-id') ?? DEFAULT_CHAT_ID;
  const agent = readArg('--agent') ?? DEFAULT_AGENT;
  const dryRun = hasFlag('--dry-run');
  const report = await buildRuntimeHealthReport({
    includeOpenBrainSearch: false,
  });
  const failures = findDeliveryFailures(report);
  if (failures.length === 0) {
    process.stdout.write(`runtime delivery monitor ok at ${report.generatedAtIso}\n`);
    if (!dryRun) writeMonitorState(statePath, { ...readMonitorState(statePath), lastFingerprint: undefined });
    return;
  }

  const fingerprint = deliveryFailureFingerprint(failures);
  const state = readMonitorState(statePath);
  const message = formatDeliveryFailureAlert(report);
  if (state.lastFingerprint === fingerprint && !hasFlag('--repeat')) {
    process.stdout.write(`runtime delivery monitor still failing; duplicate alert suppressed at ${report.generatedAtIso}\n`);
    return;
  }

  process.stdout.write(`${message}\n`);
  if (!dryRun) {
    await sendDiscordMessage({ agent, chatId, text: message, socketPath });
    writeMonitorState(statePath, { lastFingerprint: fingerprint, lastSentAt: report.generatedAtIso });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  });
}
