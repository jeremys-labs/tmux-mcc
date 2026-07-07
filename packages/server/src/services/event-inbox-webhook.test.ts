import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createEventInboxStore,
  createEventWebhookRouter,
  type EventInboxStore,
} from '@agent-comms/event-inbox';
import { enqueuePendingRuntimeEventInbox } from './runtime-event-inbox.js';
import { createRuntimeEventEmitter } from './runtime-events.js';

const SECRET = 'test-github-secret';

/**
 * Reproduces the webhook wiring from index.ts: a raw-body-capturing JSON parser mounted
 * ahead of the router so signature verification can hash the exact bytes GitHub signed.
 */
function buildApp(store: EventInboxStore) {
  const app = express();
  app.use(
    '/api/events',
    express.json({
      limit: '2mb',
      verify: (req, _res, buf) => {
        (req as unknown as { rawBody: Buffer }).rawBody = buf;
      },
    }),
    createEventWebhookRouter(store, { githubSecret: SECRET }),
  );
  return app;
}

function signGitHub(body: string): string {
  return `sha256=${crypto.createHmac('sha256', SECRET).update(Buffer.from(body, 'utf8')).digest('hex')}`;
}

// Deliveries are deduped by the x-github-delivery header, so the body can be constant.
function workflowRunBody(): string {
  return JSON.stringify({
    action: 'completed',
    repository: { full_name: 'jeremys-labs/tmux-mcc' },
    workflow_run: {
      name: 'CI',
      status: 'completed',
      conclusion: 'failure',
      updated_at: '2026-07-07T18:00:00.000Z',
    },
  });
}

async function postWebhook(
  port: number,
  body: string,
  headers: Record<string, string>,
): Promise<{ status: number; json: any }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/events/webhooks/github`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });
  return { status: res.status, json: await res.json() };
}

describe('event-inbox webhook wiring', () => {
  let tmpDir: string;
  let store: EventInboxStore;
  let server: Server;
  let port: number;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'event-inbox-webhook-'));
    store = createEventInboxStore(path.join(tmpDir, 'event-inbox.db'));
    server = createServer(buildApp(store));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('accepts a correctly signed webhook — raw body reaches the router', async () => {
    const body = workflowRunBody();
    const { status, json } = await postWebhook(port, body, {
      'x-github-event': 'workflow_run',
      'x-github-delivery': 'd1',
      'x-hub-signature-256': signGitHub(body),
    });

    expect(status).toBe(202);
    expect(json.duplicate).toBe(false);
    expect(json.ownerAgent).toBe('marcus');
    expect(store.listInbox({ agent: 'marcus', status: 'new' })).toHaveLength(1);
  });

  it('rejects a webhook with a bad signature', async () => {
    const body = workflowRunBody();
    const { status } = await postWebhook(port, body, {
      'x-github-event': 'workflow_run',
      'x-github-delivery': 'd2',
      'x-hub-signature-256': 'sha256=deadbeef',
    });

    expect(status).toBe(401);
    expect(store.listInbox({ agent: 'marcus', status: 'new' })).toHaveLength(0);
  });

  it('rejects a webhook with no signature header', async () => {
    const body = workflowRunBody();
    const { status } = await postWebhook(port, body, {
      'x-github-event': 'workflow_run',
      'x-github-delivery': 'd3',
    });

    expect(status).toBe(401);
  });

  it('dedupes a duplicate signed delivery', async () => {
    const body = workflowRunBody();
    const headers = {
      'x-github-event': 'workflow_run',
      'x-github-delivery': 'd4',
      'x-hub-signature-256': signGitHub(body),
    };

    const first = await postWebhook(port, body, headers);
    const second = await postWebhook(port, body, headers);

    expect(first.status).toBe(202);
    expect(first.json.duplicate).toBe(false);
    expect(second.status).toBe(200);
    expect(second.json.duplicate).toBe(true);
    expect(store.listInbox({ agent: 'marcus', status: 'new' })).toHaveLength(1);
  });

  it('flows an emitted webhook through store -> enqueue -> poller delivery', async () => {
    const body = workflowRunBody();
    await postWebhook(port, body, {
      'x-github-event': 'workflow_run',
      'x-github-delivery': 'd5',
      'x-hub-signature-256': signGitHub(body),
    });

    const submitPrompt = vi.fn(async () => {});
    const queued: Array<() => Promise<void>> = [];
    const deliveredIds = new Set<string>();
    const runtimeLogPath = path.join(tmpDir, 'runtime.log');

    const runPoll = () =>
      enqueuePendingRuntimeEventInbox({
        agentKey: 'marcus',
        eventInbox: store,
        deliveredIds,
        events: createRuntimeEventEmitter({ agent: 'marcus', runtime: 'claude', sinks: [] }),
        submitPrompt,
        runtimeLogPath,
        enqueue: (task) => queued.push(task),
      });

    runPoll();
    expect(queued).toHaveLength(1);
    await queued.shift()!();

    expect(submitPrompt).toHaveBeenCalledTimes(1);
    expect(submitPrompt.mock.calls[0][0]).toContain('[Event Inbox] New github event for marcus.');
    expect(store.listInbox({ agent: 'marcus', status: 'new' })).toHaveLength(0);
    expect(store.listInbox({ agent: 'marcus', status: 'acked' })).toHaveLength(1);

    // A second poll re-lists nothing new (event acked) and enqueues no duplicate work.
    runPoll();
    expect(queued).toHaveLength(0);
    expect(submitPrompt).toHaveBeenCalledTimes(1);
  });
});
