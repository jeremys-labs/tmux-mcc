import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildRuntimeHandoff,
  consumedRuntimeHandoffPath,
  runtimeHandoffPath,
  writeRuntimeHandoff,
} from './runtime-handoff.js';
import { injectPendingRuntimeHandoff } from './runtime-handoff-injection.js';
import { createRuntimeEventEmitter } from './runtime-events.js';

describe('runtime handoff injection', () => {
  let tmpDir: string;
  let previousEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-handoff-injection-'));
    previousEnv = { ...process.env };
    process.env.AGENT_MAIL_DIR = path.join(tmpDir, 'agent-mail');
    process.env.CONTENT_ROOT = path.join(tmpDir, 'content');
  });

  afterEach(() => {
    process.env = previousEnv;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('submits a pending handoff, then marks it consumed', async () => {
    const handoff = buildRuntimeHandoff({
      agent: 'enzo',
      fromRuntime: 'claude',
      toRuntime: 'codex',
      reason: 'smoke test',
      workspace: tmpDir,
      now: new Date('2026-05-12T22:00:00.000Z'),
    });
    writeRuntimeHandoff(tmpDir, handoff);
    const seenEvents: string[] = [];
    const submitted: string[] = [];

    const injected = await injectPendingRuntimeHandoff({
      workspace: tmpDir,
      events: createRuntimeEventEmitter({
        agent: 'enzo',
        runtime: 'codex',
        sinks: [(event) => seenEvents.push(event.name)],
      }),
      submitHandoff: async (prompt) => {
        submitted.push(prompt);
        expect(fs.existsSync(runtimeHandoffPath(tmpDir))).toBe(true);
      },
    });

    expect(injected).toBe(true);
    expect(submitted[0]).toContain('[Runtime Handoff]');
    expect(submitted[0]).toContain('runtime: claude -> codex');
    expect(fs.existsSync(runtimeHandoffPath(tmpDir))).toBe(false);
    expect(fs.existsSync(consumedRuntimeHandoffPath(tmpDir))).toBe(true);
    expect(seenEvents).toEqual(['onHandoffLoaded', 'onHandoffConsumed']);
  });

  it('leaves the handoff pending when submit fails', async () => {
    writeRuntimeHandoff(tmpDir, buildRuntimeHandoff({
      agent: 'enzo',
      fromRuntime: 'claude',
      toRuntime: 'codex',
      reason: 'submit failure',
      workspace: tmpDir,
    }));

    await expect(
      injectPendingRuntimeHandoff({
        workspace: tmpDir,
        events: createRuntimeEventEmitter({ agent: 'enzo', runtime: 'codex', sinks: [] }),
        submitHandoff: async () => {
          throw new Error('pty unavailable');
        },
      })
    ).rejects.toThrow('pty unavailable');

    expect(fs.existsSync(runtimeHandoffPath(tmpDir))).toBe(true);
    expect(fs.existsSync(consumedRuntimeHandoffPath(tmpDir))).toBe(false);
  });

  it('returns false when no handoff is pending', async () => {
    const injected = await injectPendingRuntimeHandoff({
      workspace: tmpDir,
      events: createRuntimeEventEmitter({ agent: 'enzo', runtime: 'codex', sinks: [] }),
      submitHandoff: vi.fn(),
    });

    expect(injected).toBe(false);
  });
});
