// Vendored from @open-brain/agent-harness-hooks v0.0.0 (open-brain/integrations/agent-harness-hooks/index.js).
// Vendored to make Open Brain an optional integration for MCC adopters who do not have the
// open-brain repo cloned as a sibling. When the package is published or extracted to a
// shared harness repo, swap the local import in open-brain-harness-hook.ts back to the package.

export type OpenBrainHookCommand = 'session-start' | 'answer-context' | 'capture';
export type OpenBrainHookOutputFormat = 'claude' | 'codex';
export type RuntimeContextEventName = 'SessionStart' | 'UserPromptSubmit';

export interface OpenBrainHookArgs {
  command: OpenBrainHookCommand;
  outputFormat: OpenBrainHookOutputFormat;
}

export interface RunOpenBrainHookInput {
  command: OpenBrainHookCommand;
  outputFormat: OpenBrainHookOutputFormat;
  payload: Record<string, unknown>;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export interface RunOpenBrainHookHandlers {
  resolveStartupContext(
    agentKey: string,
    payload: Record<string, unknown>,
    outputFormat: OpenBrainHookOutputFormat,
  ): Promise<string> | string;
  resolveAnswerContext(
    agentKey: string,
    promptText: string,
    payload: Record<string, unknown>,
    outputFormat: OpenBrainHookOutputFormat,
  ): Promise<string> | string;
  captureEvent(
    agentKey: string,
    eventName: string,
    payload: Record<string, unknown>,
  ): Promise<void> | void;
}

const COMMANDS = new Set<OpenBrainHookCommand>(['session-start', 'answer-context', 'capture']);

export function parseOpenBrainHookArgs(argv: string[]): OpenBrainHookArgs {
  const command = argv[0] ?? '';
  if (!COMMANDS.has(command as OpenBrainHookCommand)) {
    throw new Error('Usage: open-brain-hook <session-start|answer-context|capture> [--format claude|codex]');
  }
  const formatIndex = argv.indexOf('--format');
  const outputFormat: OpenBrainHookOutputFormat =
    formatIndex >= 0 && argv[formatIndex + 1] === 'codex' ? 'codex' : 'claude';
  return { command: command as OpenBrainHookCommand, outputFormat };
}

// SECURITY BOUNDARY: routing hint only — not an authenticated identity.
// OB1 server must derive owner_agent from the hashed per-agent memory key.
export function inferAgentKey(
  payload: Record<string, unknown>,
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): string {
  const cwd = typeof payload.cwd === 'string' ? payload.cwd : options.cwd ?? process.cwd();
  const parts = cwd.split('/').filter(Boolean);
  const agentsIndex = parts.lastIndexOf('agents');
  if (agentsIndex >= 0 && parts[agentsIndex + 1]) return parts[agentsIndex + 1];
  return options.env?.AGENT_KEY ?? process.env.AGENT_KEY ?? 'unknown';
}

/**
 * TIER B, added 2026-11-19 (dc-20261119-007). isla measured 35 of 46 synthetic shapes leaking:
 * the original key:value patterns require the key to be EXACTLY `secret`, `api_key`,
 * `password` and so on, anchored on \b -- and `_` IS a word character, so `\bpassword` never
 * matches inside `db_password`. GITHUB_TOKEN=, SECRET_KEY=, private_key=,
 * aws_secret_access_key= and db_password= all survived.
 *
 * ADDITIVE ON PURPOSE: the original patterns are untouched, so nothing that redacts today can
 * stop redacting. Measured: 11 of isla's 46 redact before this change and 0 regress.
 *
 * THE VALUE RULE IS TIERED BY KEY STRENGTH (isla's call, and it corrected mine).
 *
 * B1, STRONG key words -- password, passphrase, passwd, pwd, secret, credential(s), token, api_key and
 * private_key. These signal secrecy wherever they appear, so ANY opaque value of 8+ chars with
 * no whitespace is redacted, lowercase dictionary words included. An earlier version of this
 * exempted "bare lowercase identifiers" and would have let `db_password=correcthorsebattery`
 * through -- the most common real password shape there is. A memory saying
 * `password: hunter2horse` does not need to keep the value.
 *
 * B2, AMBIGUOUS keys -- any OTHER compound ending in `key`, plus `jwt` and `pat`.
 * `primary_key`, `foreign_key`, `sort_key` and `partition_key` are schema vocabulary; `jwt`
 * and `pat` are ordinary words and `Pat` is a given name. Breadth here is where the
 * FALSE-POSITIVE risk lives, and a false positive at this boundary is irreversible: the raw
 * text is overwritten before anything stores it, nothing logs the substitution, and the agent
 * whose memory it was cannot notice. So B2 requires a credential-LOOKING value: an uppercase
 * letter AND a digit.
 *
 * Both conditions, not either, and the negative set is why: `primary_key: CUSTOMER_ID` has no
 * digit, `sort_key: ts_bucket_2024` has no uppercase, `signing_key: rotated_last_week` has
 * neither. All three are prose and all three survive.
 *
 * B2 IS CASE-SENSITIVE ON PURPOSE. Under the `i` flag `[A-Z]` also matches lowercase, which
 * would make the value test vacuous, so its key words are spelled by character class.
 *
 * NOTHING BUT REGEX LITERALS GOES INSIDE THE ARRAY BELOW. The drift test renders the array
 * from the runtime regex objects and compares that against the SIBLING COPY'S SOURCE TEXT, so
 * a comment between the brackets breaks the byte-identity check that keeps the two copies
 * honest. Documentation lives here instead.
 */
const DEFAULT_REDACTION_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,
  /\b(?:Bearer|Token|Authorization)\s*:?\s+(?:(?:Basic|Bearer|Token)\s+)?[A-Za-z0-9._~+/=-]{16,}\b/gi,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\b[A-Z][A-Z0-9_]*(?:PASSWORD|PASSPHRASE|SECRET(?:_KEY)?|API_KEY|ACCESS_TOKEN|REFRESH_TOKEN|AUTH_TOKEN|BOT_TOKEN|PRIVATE_KEY|CREDENTIALS?)[A-Z0-9_]*\s*=\s*["']?[^\s"',;}\]]{8,}/g,
  /\b(?:password|passwd|pwd|passphrase|secret|client[_-]?secret|api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|bot[_-]?token)\s*["']?\s*[:=]\s*["']?[^\s"',;}\]]{8,}/gi,
  /\b[A-Za-z0-9_.-]*(?:password|passphrase|passwd|pwd|secret|credentials?|token|api[_-]?key|private[_-]?key)\s*["']?\s*[:=]\s*["']?[^\s"',;}\]]{8,}/gi,
  /\b(?:(?!(?:[Mm]onkey|[Tt]urkey|[Hh]ockey|[Dd]onkey|[Ww]hiskey|[Jj]ockey|[Ll]ackey|[Mm]alarkey|[Mm]ickey|[Hh]ickey|[Dd]ickey|[Pp]okey|[Hh]okey|[Ff]lunkey|[Ss]mokey|[Ll]owkey|[Dd]oohickey)(?![A-Za-z0-9_.-]))[A-Za-z0-9][A-Za-z0-9_.-]*[Kk][Ee][Yy]|[Jj][Ww][Tt]|[Pp][Aa][Tt])\s*["']?\s*[:=]\s*["']?(?=[^\s"',;}\]]*[A-Z])(?=[^\s"',;}\]]*[0-9])[^\s"',;}\]]{8,}/g,
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
];

const REDACTION_MARKER = '[REDACTED]';

const SENSITIVE_KEYS = new Set([
  'authorization',
  'cookie',
  'credentials',
  'credential',
  'password',
  'passwd',
  'passphrase',
  'privatekey',
  'pwd',
  'setcookie',
  'signingkey',
]);

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (SENSITIVE_KEYS.has(normalized)) return true;
  if (normalized === 'secret' || normalized.endsWith('secret') || normalized.endsWith('secretkey')) return true;
  if (normalized.endsWith('apikey') || normalized.endsWith('accesskey')) return true;
  if (normalized.endsWith('password') || normalized.endsWith('passphrase')) return true;
  if (normalized.endsWith('credential') || normalized.endsWith('credentials')) return true;
  return /^(?:api|access|auth|bearer|bot|client|discord|github|id|mcp|refresh|service|session|slack)?token$/.test(normalized);
}

export function redactString(value: string, patterns: RegExp[] = DEFAULT_REDACTION_PATTERNS): string {
  if (typeof value !== 'string') return value;
  let out = value;
  for (const pattern of patterns) out = out.replace(pattern, REDACTION_MARKER);
  return out;
}

export function redactPayload<T>(payload: T, patterns: RegExp[] = DEFAULT_REDACTION_PATTERNS): T {
  if (payload == null) return payload;
  if (typeof payload === 'string') return redactString(payload, patterns) as unknown as T;
  if (Array.isArray(payload)) return payload.map((item) => redactPayload(item, patterns)) as unknown as T;
  if (typeof payload === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
      out[key] = isSensitiveKey(key) && value !== undefined && value !== null
        ? REDACTION_MARKER
        : redactPayload(value, patterns);
    }
    return out as unknown as T;
  }
  return payload;
}

export function extractPromptText(payload: Record<string, unknown>): string {
  const candidates = [payload.prompt, payload.user_prompt, payload.userPrompt, payload.message, payload.content, payload.input];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate;
  }
  return '';
}

export function extractHookEventName(payload: Record<string, unknown>): string {
  if (typeof payload.hook_event_name === 'string') return payload.hook_event_name;
  if (typeof payload.hookEventName === 'string') return payload.hookEventName;
  return 'unknown';
}

export function formatClaudeAdditionalContext(eventName: string, additionalContext: string): string {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: eventName, additionalContext },
  });
}

export function formatCodexSystemMessage(systemMessage: string): string {
  return JSON.stringify({ continue: true, systemMessage });
}

export function formatRuntimeContextOutput(
  outputFormat: OpenBrainHookOutputFormat,
  eventName: RuntimeContextEventName,
  context: string,
): string {
  if (!context) return '';
  if (outputFormat === 'codex') return formatCodexSystemMessage(context);
  return formatClaudeAdditionalContext(eventName, context);
}

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_SESSION_START_TIMEOUT_MS = 16000;

function withTimeout<T>(promise: Promise<T> | T, timeoutMs: number, label: string): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.resolve(promise);
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function logHookFailure(command: string, err: unknown): void {
  const message = err && (err as Error).message ? (err as Error).message : String(err);
  try {
    process.stderr.write(`[open-brain-hook] ${command} failed: ${message}\n`);
  } catch {
    // stderr unavailable; swallow — hooks must never throw to the runtime.
  }
}

// Hooks fail open: if Open Brain is slow, unreachable, or a handler throws,
// the user prompt must still proceed without injected context.
export async function runOpenBrainHarnessHook(
  input: RunOpenBrainHookInput,
  handlers: RunOpenBrainHookHandlers,
): Promise<string> {
  const agentKey = inferAgentKey(input.payload, { cwd: input.cwd, env: input.env });
  const defaultTimeoutMs = input.command === 'session-start'
    ? DEFAULT_SESSION_START_TIMEOUT_MS
    : DEFAULT_TIMEOUT_MS;
  const timeoutMs = Number.isFinite(input.timeoutMs) ? (input.timeoutMs as number) : defaultTimeoutMs;

  try {
    if (input.command === 'session-start') {
      const context = await withTimeout(
        handlers.resolveStartupContext(agentKey, input.payload, input.outputFormat),
        timeoutMs,
        'session-start',
      );
      return formatRuntimeContextOutput(input.outputFormat, 'SessionStart', context);
    }

    if (input.command === 'answer-context') {
      const text = extractPromptText(input.payload);
      if (!text) return '';
      const context = await withTimeout(
        handlers.resolveAnswerContext(agentKey, text, input.payload, input.outputFormat),
        timeoutMs,
        'answer-context',
      );
      return formatRuntimeContextOutput(input.outputFormat, 'UserPromptSubmit', context);
    }

    const redactedPayload = redactPayload(input.payload);
    await withTimeout(
      handlers.captureEvent(agentKey, extractHookEventName(input.payload), redactedPayload),
      timeoutMs,
      'capture',
    );
    return '';
  } catch (err) {
    logHookFailure(input.command, err);
    return '';
  }
}
