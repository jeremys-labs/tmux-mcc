#!/usr/bin/env node
export {};
import { pathToFileURL } from 'node:url';
import { requestDiscordBridge } from './discord-bridge-socket.js';

type Args = {
  agent?: string;
  bindingName?: string;
  chatId?: string;
  limit?: number;
  before?: string;
  after?: string;
  around?: string;
  socketPath: string;
};

export function parseArgs(argv: string[]): Args {
  const args: Args = {
    socketPath: process.env.DISCORD_BRIDGE_SOCKET_PATH ?? '/tmp/agent-discord-bridge.sock',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    const next = argv[index + 1];
    if (item === '--agent') {
      args.agent = next;
      index += 1;
    } else if (item === '--binding' || item === '--binding-name' || item === '--binding_name') {
      args.bindingName = next;
      index += 1;
    } else if (item === '--chat-id' || item === '--chat_id') {
      args.chatId = next;
      index += 1;
    } else if (item === '--limit') {
      args.limit = Number(next);
      index += 1;
    } else if (item === '--before') {
      args.before = next;
      index += 1;
    } else if (item === '--after') {
      args.after = next;
      index += 1;
    } else if (item === '--around') {
      args.around = next;
      index += 1;
    } else if (item === '--socket-path') {
      args.socketPath = next ?? args.socketPath;
      index += 1;
    }
  }
  return args;
}

export function buildHistoryPayload(args: Args): string {
  if (!args.agent || !args.chatId) {
    throw new Error('Usage: discord-bridge-history --agent <agent> --chat-id <channel> [--limit 1-100] [--before id | --after id | --around id]');
  }
  if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 100)) {
    throw new Error(`--limit must be an integer from 1 to 100: ${args.limit}`);
  }
  return JSON.stringify({
    agentKey: args.agent,
    chat_id: args.chatId,
    ...(args.bindingName ? { bindingName: args.bindingName } : {}),
    ...(args.limit !== undefined ? { limit: args.limit } : {}),
    ...(args.before ? { before: args.before } : {}),
    ...(args.after ? { after: args.after } : {}),
    ...(args.around ? { around: args.around } : {}),
  });
}

export async function requestHistory(socketPath: string, payload: string): Promise<string> {
  return requestDiscordBridge(socketPath, '/history', payload);
}

async function main(): Promise<void> {
  try {
    const args = parseArgs(process.argv.slice(2));
    const payload = buildHistoryPayload(args);
    const body = await requestHistory(args.socketPath, payload);
    console.log(body);
  } catch (error) {
    console.error(String(error instanceof Error ? error.message : error));
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
