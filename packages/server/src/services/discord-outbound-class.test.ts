import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  formatPolicyRefusal,
  isOutboundClass,
  OUTBOUND_CLASSES,
  parsePolicyRefusal,
} from './discord-outbound-class.js';

describe('outbound class vocabulary', () => {
  it('matches the bridge policy vocabulary exactly', () => {
    // A SET, not a count. A length assertion passes on the wrong four names, and
    // a class the bridge doesn't know comes back as an opaque 400 at the socket.
    expect([...OUTBOUND_CLASSES].sort()).toEqual([
      'alert', 'interactive_reply', 'scheduled_digest', 'system_monitor',
    ]);
  });

  it('rejects an unknown class locally', () => {
    expect(isOutboundClass('interactive_reply')).toBe(true);
    expect(isOutboundClass('scheduled-digest')).toBe(false);
    expect(isOutboundClass('digest')).toBe(false);
    expect(isOutboundClass(undefined)).toBe(false);
  });
});

describe('policy refusal parsing', () => {
  it('recognises only the policy refusal body', () => {
    expect(parsePolicyRefusal(JSON.stringify({ error: 'outbound_policy_denied' }))).not.toBeNull();
    expect(parsePolicyRefusal(JSON.stringify({ error: 'not found' }))).toBeNull();
    expect(parsePolicyRefusal('socket hang up')).toBeNull();
    expect(parsePolicyRefusal('')).toBeNull();
  });

  it('carries the rule id, the repair and the stated limitation into the message', () => {
    const text = formatPolicyRefusal({
      error: 'outbound_policy_denied',
      ruleIds: ['eli5.file_path'],
      violations: [{
        ruleId: 'eli5.file_path',
        message: 'The message includes an internal file path.',
        repair: 'Name the document in plain English.',
      }],
      repair: 'Rewrite in plain English.',
      limitation: 'It cannot catch plain English that still assumes context.',
    });
    expect(text).toContain('was NOT sent');
    expect(text).toContain('eli5.file_path');
    expect(text).toContain('Name the document in plain English.');
    expect(text).toContain('Known limitation:');
  });
});

describe('the reply CLI against a stub bridge', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()?.();
  });

  type Stub = { socketPath: string; received: string[] };

  function startStub(status: number, body: unknown): Promise<Stub> {
    // A UNIX SOCKET PATH HAS A ~104-BYTE LIMIT ON macOS. Putting it under this
    // session's scratchpad produced `listen EINVAL`, which reads as a bad
    // argument rather than as "the path is too long", so the socket goes in
    // os.tmpdir().
    const socketPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'obc-')), 'b.sock');
    const received: string[] = [];
    const server = http.createServer((req, res) => {
      let chunk = '';
      req.setEncoding('utf8');
      req.on('data', (part) => { chunk += part; });
      req.on('end', () => {
        received.push(chunk);
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      });
    });
    cleanups.push(() => {
      // closeAllConnections first: close() alone waits on live sockets and hangs
      // the runner at teardown instead of failing anything.
      server.closeAllConnections();
      server.close();
      try { fs.rmSync(path.dirname(socketPath), { recursive: true, force: true }); } catch { /* best effort */ }
    });
    return new Promise((resolve) => {
      server.listen(socketPath, () => resolve({ socketPath, received }));
    });
  }

  /**
   * ASYNC ON PURPOSE. `spawnSync` BLOCKS THE EVENT LOOP, and the stub bridge runs
   * in THIS process -- so the CLI would connect, send, and wait forever for a
   * response the blocked loop could never write, while spawnSync waited forever
   * for the CLI. A deadlock by construction, which presents as a runner that
   * hangs rather than a test that fails.
   */
  function runCli(socketPath: string, extra: string[]): Promise<{ status: number | null; stderr: string }> {
    // tsx lives in the WORKSPACE ROOT's node_modules, not the package's. An
    // existsSync check here is worth its line: a missing binary surfaces as a
    // null exit status, which reads as a behaviour failure rather than as "the
    // binary was never run".
    const tsx = path.join(import.meta.dirname, '..', '..', '..', '..', 'node_modules', '.bin', 'tsx');
    if (!fs.existsSync(tsx)) throw new Error(`tsx not found at ${tsx}`);
    const cli = path.join(import.meta.dirname, '..', 'discord-bridge-reply.ts');
    const child = spawn(
      tsx,
      [cli, '--agent', 'marcus', '--chat-id', '1492892431543308439',
        '--text', 'a plain one line message', '--socket-path', socketPath, ...extra],
      {
        // Point the agent-time checker at nothing: that branch fails open by
        // design, so the send under test proceeds without needing python here.
        env: { ...process.env, DEFERRAL_CHECK: '/nonexistent-checker' },
      },
    );
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdout.resume();
    return new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (status) => resolve({ status, stderr }));
    });
  }

  const OK = { ok: true, id: '1', attachmentCount: 0 };

  it('declares interactive_reply when no class is given, because the default must be the strictest', async () => {
    const stub = await startStub(200, OK);
    expect((await runCli(stub.socketPath, [])).status).toBe(0);
    expect(JSON.parse(stub.received[0]).outboundClass).toBe('interactive_reply');
  });

  it('declares the class it is given', async () => {
    const stub = await startStub(200, OK);
    expect((await runCli(stub.socketPath, ['--outbound-class', 'scheduled_digest'])).status).toBe(0);
    expect(JSON.parse(stub.received[0]).outboundClass).toBe('scheduled_digest');
  });

  it('refuses an unknown class before it reaches the socket', async () => {
    const stub = await startStub(200, OK);
    const run = await runCli(stub.socketPath, ['--outbound-class', 'digest']);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('--outbound-class must be one of');
    expect(stub.received).toHaveLength(0);
  });

  it('exits 3 with a legible refusal, not a stack trace, when the policy denies the send', async () => {
    const stub = await startStub(422, {
      error: 'outbound_policy_denied',
      ruleIds: ['eli5.document_shape'],
      violations: [{
        ruleId: 'eli5.document_shape',
        message: 'The reply is formatted like a document instead of a conversational message.',
        repair: 'Remove section headings and excess bullets.',
      }],
      repair: 'Rewrite the message in plain English.',
      limitation: 'It cannot catch plain English that still assumes context.',
    });
    const run = await runCli(stub.socketPath, []);
    expect(run.status).toBe(3);
    expect(run.stderr).toContain('eli5.document_shape');
    expect(run.stderr).toContain('Remove section headings');
    expect(run.stderr).toContain('Known limitation:');
    // The distinction a refusal exists to make: rewrite the message, don't debug
    // the bridge. A stack frame here would erase it.
    expect(run.stderr).not.toContain('at Object.');
    expect(run.stderr).not.toContain('reject(new Error');
  });

  it('still fails with exit 1 on a genuine bridge error, which IS a thing to debug', async () => {
    const stub = await startStub(500, { error: 'missing token env var DISCORD_BOT_TOKEN_MARCUS' });
    const run = await runCli(stub.socketPath, []);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('missing token env var');
  });
});
