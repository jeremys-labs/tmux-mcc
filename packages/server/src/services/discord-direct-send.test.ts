import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  formatDirectDiscordSendFailure,
  logDirectDiscordSendFailure,
} from './discord-direct-send.js';
import { sendDiscordChunkWithRetry } from './open-brain-grooming-digest.js';

// The real incident this regression is tied to (Loop 5, 2026-06-08): a direct-token
// Discord POST that 403'd silently. These values are the actual observed failure.
const INCIDENT_CHANNEL = '1493425484036309092';
const INCIDENT_BODY = '{"message": "Missing Access", "code": 50001}';

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.DISCORD_SEND_HEALTH_LOG;
});

describe('formatDirectDiscordSendFailure', () => {
  it('produces the one canonical, greppable shape (matches the supervisor leg-3 line)', () => {
    const line = formatDirectDiscordSendFailure('grooming-digest', INCIDENT_CHANNEL, 403, INCIDENT_BODY);
    expect(line).toBe(
      `grooming-digest direct-token Discord POST FAILED to chat ${INCIDENT_CHANNEL}: status=403 ${INCIDENT_BODY}`,
    );
    // the fleet-wide oracle grep must match it
    expect(line).toContain('direct-token Discord POST FAILED');
    expect(line).toContain('status=403');
  });
});

describe('logDirectDiscordSendFailure', () => {
  it('appends the standardized line to the given log path', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-health-'));
    const logPath = path.join(dir, 'health.log');
    logDirectDiscordSendFailure('grooming-digest', INCIDENT_CHANNEL, 403, INCIDENT_BODY, logPath);
    const contents = fs.readFileSync(logPath, 'utf8');
    expect(contents).toContain('[discord-send]');
    expect(contents).toContain(`grooming-digest direct-token Discord POST FAILED to chat ${INCIDENT_CHANNEL}: status=403`);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('is best-effort — an unwritable log path never throws', () => {
    expect(() =>
      logDirectDiscordSendFailure('x', 'c', 500, 'b', '/this/path/does/not/exist/and/cannot/be/made\0/health.log'),
    ).not.toThrow();
  });
});

describe('contract: every direct-token Discord message-sender logs failures via the standard helper', () => {
  it('no POST-to-/messages site bypasses logDirectDiscordSendFailure', () => {
    const root = path.resolve(__dirname, '..');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue;
        if (entry.name === 'discord-direct-send.ts') continue; // the helper itself
        const src = fs.readFileSync(full, 'utf8');
        const postsToMessages = /channels\/\$\{[^}]*\}\/messages`/.test(src) && /method:\s*['"]POST/.test(src);
        if (postsToMessages && !src.includes('logDirectDiscordSendFailure')) offenders.push(path.relative(root, full));
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});

describe('regression: grooming-digest 403 surfaces a standardized oracle line (not a silent swallow)', () => {
  it('a non-2xx direct-token send writes the standard FAILED line and throws', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-health-'));
    const logPath = path.join(dir, 'health.log');
    process.env.DISCORD_SEND_HEALTH_LOG = logPath;
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 403,
      text: async () => INCIDENT_BODY,
    })));

    await expect(
      sendDiscordChunkWithRetry(INCIDENT_CHANNEL, 'fake-token', 'hello', 1),
    ).rejects.toThrow(/Discord digest send failed/);

    const contents = fs.readFileSync(logPath, 'utf8');
    expect(contents).toContain(`grooming-digest direct-token Discord POST FAILED to chat ${INCIDENT_CHANNEL}: status=403`);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
