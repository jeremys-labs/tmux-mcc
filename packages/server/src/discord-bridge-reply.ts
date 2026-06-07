#!/usr/bin/env node
export {};
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { normalizeInlineDiscordText } from './services/discord-reply-text.js';

type Args = {
  agent?: string;
  chatId?: string;
  text?: string;
  textFile?: string;
  textStdin: boolean;
  replyTo?: string;
  files: string[];
  socketPath: string;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    files: [],
    textStdin: false,
    socketPath: process.env.DISCORD_BRIDGE_SOCKET_PATH ?? '/tmp/agent-discord-bridge.sock',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    const next = argv[index + 1];
    if (item === '--agent') {
      args.agent = next;
      index += 1;
    } else if (item === '--chat-id' || item === '--chat_id') {
      args.chatId = next;
      index += 1;
    } else if (item === '--text') {
      args.text = next;
      index += 1;
    } else if (item === '--text-file') {
      args.textFile = next;
      index += 1;
    } else if (item === '--text-stdin') {
      args.textStdin = true;
    } else if (item === '--reply-to' || item === '--reply_to') {
      args.replyTo = next;
      index += 1;
    } else if (item === '--file') {
      if (next) args.files.push(next);
      index += 1;
    } else if (item === '--socket-path') {
      args.socketPath = next ?? args.socketPath;
      index += 1;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (args.text !== undefined) {
  args.text = normalizeInlineDiscordText(args.text);
}

if (args.textFile) {
  if (!path.isAbsolute(args.textFile)) {
    console.error(`--text-file must be an absolute path: ${args.textFile}`);
    process.exit(1);
  }
  args.text = fs.readFileSync(args.textFile, 'utf8');
}

if (args.textStdin) {
  args.text = fs.readFileSync(0, 'utf8');
}

if (!args.agent || !args.chatId || (!args.text && args.files.length === 0)) {
  console.error('Usage: discord-bridge-reply --agent <agent> --chat-id <channel> [--text <message> | --text-file <abs-path> | --text-stdin] [--file <abs-path> ...] [--reply-to <message_id>]');
  process.exit(1);
}

if (args.files.length > 10) {
  console.error('discord-bridge-reply supports at most 10 --file attachments.');
  process.exit(1);
}

for (const filePath of args.files) {
  if (!path.isAbsolute(filePath)) {
    console.error(`--file must be an absolute path: ${filePath}`);
    process.exit(1);
  }
  const stat = fs.existsSync(filePath) ? fs.statSync(filePath) : null;
  if (!stat?.isFile()) {
    console.error(`--file path is not a readable file: ${filePath}`);
    process.exit(1);
  }
}

const payload = JSON.stringify({
  agentKey: args.agent,
  chat_id: args.chatId,
  ...(args.text ? { text: args.text } : {}),
  ...(args.files.length > 0 ? { files: args.files } : {}),
  ...(args.replyTo ? { reply_to: args.replyTo } : {}),
  ...(process.env.SCHEDULED_DISCORD_SOURCE ? { source: process.env.SCHEDULED_DISCORD_SOURCE } : {}),
  ...(process.env.SCHEDULED_JOB_ID ? { job_id: process.env.SCHEDULED_JOB_ID } : {}),
  ...(process.env.SCHEDULED_JOB_LABEL ? { label: process.env.SCHEDULED_JOB_LABEL } : {}),
  ...(process.env.SCHEDULED_AWAITING_REPLY === '1' ? { awaiting_reply: true } : {}),
});

const body = await new Promise<string>((resolve, reject) => {
  const req = http.request({
    socketPath: args.socketPath,
    path: '/send',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    },
  }, (res) => {
    let responseBody = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => { responseBody += chunk; });
    res.on('end', () => {
      if ((res.statusCode ?? 500) < 200 || (res.statusCode ?? 500) >= 300) {
        reject(new Error(responseBody));
        return;
      }
      resolve(responseBody);
    });
  });
  req.on('error', reject);
  req.end(payload);
});

console.log(body);
