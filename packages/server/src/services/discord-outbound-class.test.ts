import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  decideOutboundClass,
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
  function runCli(
    socketPath: string,
    extra: string[],
    opts: { scheduledJobId?: string; journalPath?: string } = {},
  ): Promise<{ status: number | null; stderr: string }> {
    const scheduledJobId = opts.scheduledJobId ?? '';
    const journalPath = opts.journalPath ?? path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'obj-')), 'c.jsonl');
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
        // OUTBOUND_CLASS_JOURNAL is redirected so the test never appends to the
        // fleet's real report.
        env: {
          ...process.env,
          DEFERRAL_CHECK: '/nonexistent-checker',
          OUTBOUND_CLASS_JOURNAL: journalPath,
          SCHEDULED_JOB_ID: scheduledJobId,
        },
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

describe('class decision, and which way it was decided', () => {
  it('a declared class always wins, even inside a scheduled turn', () => {
    expect(decideOutboundClass('interactive_reply', { SCHEDULED_JOB_ID: 'job-1' }))
      .toEqual({ outboundClass: 'interactive_reply', origin: 'declared' });
    expect(decideOutboundClass('alert', {}))
      .toEqual({ outboundClass: 'alert', origin: 'declared' });
  });

  it('infers scheduled_digest inside a scheduled turn and carries the job id', () => {
    expect(decideOutboundClass(undefined, { SCHEDULED_JOB_ID: '35241488-f8' })).toEqual({
      outboundClass: 'scheduled_digest',
      origin: 'inferred',
      scheduledJobId: '35241488-f8',
    });
  });

  it('infers interactive_reply outside a scheduled turn, which is the strict side', () => {
    expect(decideOutboundClass(undefined, {}))
      .toEqual({ outboundClass: 'interactive_reply', origin: 'inferred' });
  });

  it('treats an EMPTY or whitespace job id as absent, so a blank env var cannot relax the class', () => {
    // This is the fail-open edge: `env: { ...process.env, SCHEDULED_JOB_ID: job.id }`
    // with an id-less job would set the variable to an empty string, and a bare
    // presence check would then class every interactive reply as a digest.
    expect(decideOutboundClass(undefined, { SCHEDULED_JOB_ID: '' }).outboundClass).toBe('interactive_reply');
    expect(decideOutboundClass(undefined, { SCHEDULED_JOB_ID: '   ' }).outboundClass).toBe('interactive_reply');
    expect(decideOutboundClass(undefined, { SCHEDULED_JOB_ID: '   ' }).origin).toBe('inferred');
  });

  it('never reports a declared origin for something it inferred', () => {
    for (const env of [{}, { SCHEDULED_JOB_ID: 'x' }, { SCHEDULED_JOB_ID: '' }]) {
      expect(decideOutboundClass(undefined, env).origin).toBe('inferred');
    }
  });
});

describe('the inferred default on the wire, and its journal', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => { while (cleanups.length > 0) cleanups.pop()?.(); });

  function stub(): Promise<{ socketPath: string; received: string[] }> {
    const socketPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'obi-')), 'b.sock');
    const received: string[] = [];
    const server = http.createServer((req, res) => {
      let chunk = '';
      req.setEncoding('utf8');
      req.on('data', (part) => { chunk += part; });
      req.on('end', () => {
        received.push(chunk);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, id: '1', attachmentCount: 0 }));
      });
    });
    cleanups.push(() => {
      server.closeAllConnections();
      server.close();
      try { fs.rmSync(path.dirname(socketPath), { recursive: true, force: true }); } catch { /* best effort */ }
    });
    return new Promise((resolve) => server.listen(socketPath, () => resolve({ socketPath, received })));
  }

  function runWith(socketPath: string, extra: string[], env: Record<string, string>, journalPath: string) {
    const tsx = path.join(import.meta.dirname, '..', '..', '..', '..', 'node_modules', '.bin', 'tsx');
    const cli = path.join(import.meta.dirname, '..', 'discord-bridge-reply.ts');
    const child = spawn(tsx, [cli, '--agent', 'isla', '--chat-id', '1493425484036309092',
      '--text', 'a plain line', '--socket-path', socketPath, ...extra], {
      env: { ...process.env, DEFERRAL_CHECK: '/nonexistent-checker',
             OUTBOUND_CLASS_JOURNAL: journalPath, ...env },
    });
    child.stdout.resume();
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c) => { stderr += c; });
    return new Promise<{ status: number | null; stderr: string }>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (status) => resolve({ status, stderr }));
    });
  }

  function journal(journalPath: string): Array<Record<string, unknown>> {
    if (!fs.existsSync(journalPath)) return [];
    return fs.readFileSync(journalPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }

  it('a scheduled turn with no flag sends scheduled_digest, journalled as inferred', async () => {
    const s = await stub();
    const jp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'obj-')), 'c.jsonl');
    const run = await runWith(s.socketPath, [], { SCHEDULED_JOB_ID: '35241488-f8' }, jp);
    expect(run.status).toBe(0);
    expect(JSON.parse(s.received[0]).outboundClass).toBe('scheduled_digest');
    const rows = journal(jp);
    expect(rows).toHaveLength(1);
    expect(rows[0].origin).toBe('inferred');
    expect(rows[0].scheduled_job_id).toBe('35241488-f8');
    expect(rows[0].declared_non_interactive).toBe(false);
  });

  it('no scheduled turn and no flag still sends interactive_reply', async () => {
    const s = await stub();
    const jp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'obj-')), 'c.jsonl');
    const run = await runWith(s.socketPath, [], { SCHEDULED_JOB_ID: '' }, jp);
    expect(run.status).toBe(0);
    expect(JSON.parse(s.received[0]).outboundClass).toBe('interactive_reply');
    expect(journal(jp)[0].origin).toBe('inferred');
  });

  it('flags a DECLARED non-interactive send, which is how honour-system misuse stays auditable', async () => {
    const s = await stub();
    const jp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'obj-')), 'c.jsonl');
    const run = await runWith(s.socketPath, ['--outbound-class', 'scheduled_digest'], {}, jp);
    expect(run.status).toBe(0);
    const row = journal(jp)[0];
    expect(row.origin).toBe('declared');
    expect(row.declared_non_interactive).toBe(true);
  });

  it('journals exactly the class it sent, so the record cannot diverge from the wire', async () => {
    const s = await stub();
    const jp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'obj-')), 'c.jsonl');
    await runWith(s.socketPath, [], { SCHEDULED_JOB_ID: 'job-xyz' }, jp);
    expect(journal(jp)[0].outbound_class).toBe(JSON.parse(s.received[0]).outboundClass);
  });
});
