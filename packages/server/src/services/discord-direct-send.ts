import fs from 'fs';
import path from 'path';

// Standardized failure logging for DIRECT-TOKEN Discord sends (those that POST
// straight to discord.com/api with a bot token, bypassing the discord:reply
// bridge — e.g. the OB1 grooming/decision digests and the agent-supervisor's
// delivery-reconciler alarm leg).
//
// WHY THIS EXISTS (Loop 5, 2026-06-08): the delivery reconciler's leg-3 was a
// fire-and-forget direct-token POST that never read its response, so a 403
// vanished silently — the exact silent-delivery-failure class the reconciler
// exists to catch, reproduced inside the monitor. The fix that mattered was not
// just "read the status" but emitting a UNIFORM, greppable line to a file
// anyone can read, turning the log into a durable health oracle. This module
// makes that line identical across every direct-token sender, so a single
//   grep "direct-token Discord POST FAILED" <logs>
// is a fleet-wide silent-Discord-failure oracle — not N ad-hoc per-site logs.

// Shared oracle log. Every direct-token sender appends its failures here in one
// shape. Persistent (not /tmp) so the oracle survives restarts and reboots.
// Resolved at call time so the path is overridable (tests, alternate hosts).
export function discordSendHealthLogPath(): string {
  return process.env.DISCORD_SEND_HEALTH_LOG ?? '/Volumes/Repo-Drive/agents/SHARED/discord-send-health.log';
}

// The ONE canonical failure-line shape. Matches the agent-supervisor leg-3 line
// (`<sender> direct-token Discord POST FAILED to chat <id>: status=<n> <body>`)
// so a single grep spans both repos' logs.
export function formatDirectDiscordSendFailure(
  sender: string,
  channelId: string,
  status: number,
  body: string,
): string {
  return `${sender} direct-token Discord POST FAILED to chat ${channelId}: status=${status} ${body.slice(0, 300)}`;
}

// Append a standardized failure line to the shared health-oracle log. Best-effort:
// a logging failure must never break (or mask) the send path it observes — the
// same discipline the leg-3 incident taught.
export function logDirectDiscordSendFailure(
  sender: string,
  channelId: string,
  status: number,
  body: string,
  logPath: string = discordSendHealthLogPath(),
): void {
  const line = `${new Date().toISOString()} [discord-send] ${formatDirectDiscordSendFailure(sender, channelId, status, body)}\n`;
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, line, { mode: 0o600 });
  } catch {
    // best-effort — never let the oracle's own write break a send
  }
  // eslint-disable-next-line no-console
  console.error(`[discord-send] ${formatDirectDiscordSendFailure(sender, channelId, status, body)}`);
}
