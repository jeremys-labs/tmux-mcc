import fs from 'fs';
import path from 'path';

// ─── Recall Health Canary ────────────────────────────────────────────────────
// A daily, deterministic probe (no LLM in the loop) that verifies every ACTIVE
// agent's OB1 recall returns a well-formed, correctly-scoped response via the
// agent-memory service (:4317). It catches the silent failure class — SSE
// garble / unparseable body, isError, HTTP error, timeout, and cross-agent
// mis-scope — that otherwise lets agents run memory-blind unnoticed.
//
// DON'T-CRY-WOLF RULE (ratified): alert on PIPELINE failure, NOT on match count.
// A clean "Found 0 items" means the pipe works and the store is sparse — that is
// HEALTHY and never alarms. The bug class we catch throws / mis-scopes instead.
//
// KNOWN LIMITS (v1, deliberate — documented so coverage is honest):
//  1. A degraded backend returning HTTP 200 + a clean "Found 0" for an agent
//     that DOES have memories would read as healthy. Catching that needs
//     per-agent baselines = the brittleness we're avoiding. (Future, no per-agent
//     state: flag when >half the fleet returns 0 in one run.)
//  2. The probe validates the SERVICE's own parser + scoping; it does not
//     exercise each agent wrapper's parse. That's acceptable — the wrapper is
//     shared code, so a real parse regression is fleet-wide, not per-agent.

export const RECALL_CANARY_CHAT_ID = '1493425484036309092'; // #hq
const DEFAULT_SERVICE_URL = 'http://127.0.0.1:4317';
const DEFAULT_AGENTS_ROOT = '/Volumes/Repo-Drive/agents';
const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_QUERY = 'recall health canary probe — agent role and recent activity';

export interface AgentProbeResult {
  agent: string;
  healthy: boolean;
  reason: string;
}

export interface ServiceResponse {
  status: number;
  body: string;
}

export type ProbeFetch = (agent: string) => Promise<ServiceResponse>;

function describeHttpFailure(agent: string, status: number, body: string): string {
  const fallback = `HTTP ${status}`;
  try {
    const parsed = JSON.parse(body) as { reason?: unknown; agent?: unknown };
    if (parsed.reason === 'agent_not_enabled' && parsed.agent === agent) {
      return `${fallback}: agent not enabled`;
    }
    if (parsed.reason === 'invalid_or_inactive_agent_key') {
      return `${fallback}: invalid or inactive agent memory key`;
    }
  } catch {
    // Unknown and non-JSON backend failures stay intentionally opaque.
  }
  return fallback;
}

// Active agents = directories with both an OB1 key and a launcher. Enumerated
// dynamically so retired/added agents can't desync a hardcoded list.
export function enumerateActiveAgents(agentsRoot: string = DEFAULT_AGENTS_ROOT, fsImpl = fs): string[] {
  try {
    return fsImpl
      .readdirSync(agentsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter(
        (name) =>
          fsImpl.existsSync(path.join(agentsRoot, name, '.open-brain', 'memory.env')) &&
          fsImpl.existsSync(path.join(agentsRoot, name, 'launch.sh')),
      )
      .sort();
  } catch {
    return [];
  }
}

// Pure verdict for one probe response. The :4317 service returns a plain JSON
// tool result {"text": "..."} on success (it has already de-framed OB1's SSE
// internally) or a non-200 {"error": "..."} on failure. Healthy iff HTTP 200 +
// JSON {text} + the text is a recognized, correctly-scoped recall response for
// THIS agent. Both shapes are healthy:
//   "Found N <agent>-readable memory item(s): …"   (results)
//   "No <agent>-readable memories found matching …" (zero results — sparse, OK)
export function evaluateProbeResponse(agent: string, status: number, body: string): AgentProbeResult {
  if (status !== 200) return { agent, healthy: false, reason: describeHttpFailure(agent, status, body) };
  let parsed: { text?: unknown; error?: unknown };
  try {
    parsed = JSON.parse(body.trim());
  } catch {
    return { agent, healthy: false, reason: 'unparseable JSON from service' };
  }
  if (parsed.error) return { agent, healthy: false, reason: `service error: ${String(parsed.error).slice(0, 80)}` };
  const text = typeof parsed.text === 'string' ? parsed.text : '';
  if (!text) return { agent, healthy: false, reason: 'empty service response (no text)' };
  const found = text.match(/Found\s+\d+\s+([A-Za-z0-9_-]+)-readable memory item/);
  const none = text.match(/No\s+([A-Za-z0-9_-]+)-readable memories found/);
  const scopedAgent = found?.[1] ?? none?.[1];
  if (!scopedAgent) return { agent, healthy: false, reason: 'unrecognized recall response shape' };
  if (scopedAgent.toLowerCase() !== agent.toLowerCase()) {
    return { agent, healthy: false, reason: `mis-scoped: got "${scopedAgent}"` };
  }
  return { agent, healthy: true, reason: found ? 'ok' : 'ok (0 results)' };
}

export interface ProbeOptions {
  fetchFn?: (url: string, init: Record<string, unknown>) => Promise<{ status: number; text: () => Promise<string> }>;
  serviceUrl?: string;
  timeoutMs?: number;
  query?: string;
}

function defaultProbeFetch(opts: ProbeOptions): ProbeFetch {
  const serviceUrl = opts.serviceUrl ?? DEFAULT_SERVICE_URL;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const doFetch = opts.fetchFn ?? (globalThis.fetch as unknown as NonNullable<ProbeOptions['fetchFn']>);
  return async (agent: string) => {
    // Per-agent query (includes the agent name) so a healthy agent with memory
    // tends to return "Found N" — exercising real retrieval — without asserting
    // any count (a "No … found" zero result is still healthy per the design).
    const query = opts.query ?? `${DEFAULT_QUERY} for ${agent}`;
    const response = await doFetch(new URL('/v1/tool', serviceUrl).toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agentKey: agent,
        name: 'search_agent_memory',
        args: { query, limit: 1, threshold: 0.0 },
        options: {},
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { status: response.status, body: await response.text() };
  };
}

// Probes one agent with retry-once on a TRANSIENT failure (network/timeout or
// HTTP 5xx). Permanent verdicts (4xx, isError, mis-scope, unparseable) do not
// retry — they are real signal.
export async function probeAgent(agent: string, probeFetch: ProbeFetch): Promise<AgentProbeResult> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const { status, body } = await probeFetch(agent);
      const verdict = evaluateProbeResponse(agent, status, body);
      if (verdict.healthy) return verdict;
      if (attempt === 0 && status >= 500) continue; // transient server error -> retry once
      return verdict;
    } catch (error) {
      if (attempt === 0) continue; // network/timeout -> retry once
      return { agent, healthy: false, reason: `request failed: ${String(error).slice(0, 120)}` };
    }
  }
  return { agent, healthy: false, reason: 'request failed after retry' };
}

// One #hq line per run — daily heartbeat (✅) so a dead canary is detectable,
// plus the exception detail when any agent is blind.
export function formatCanaryLine(results: AgentProbeResult[]): string {
  const total = results.length;
  const blind = results.filter((result) => !result.healthy);
  if (total === 0) return '⚠️ recall canary: no active agents found';
  if (blind.length === 0) return `✅ recall verified ${total}/${total} agents`;
  const detail = blind.map((result) => `${result.agent} (${result.reason})`).join(', ');
  const names = blind.map((result) => result.agent).join(', ');
  const they = blind.length === 1 ? 'it will' : 'they will';
  // Say what it costs, not just that a probe failed — this line lands in Jeremy's
  // DM, and "recall BLIND" made him ask what it meant (2026-07-27).
  return `⚠️ Cannot read memory for ${names} — ${they} start cold (no recall of prior context; nothing lost, writes still work). ${detail}. Healthy ${total - blind.length}/${total}.`;
}

export async function runRecallCanary(
  options: ProbeOptions & { agentsRoot?: string; agents?: string[]; probeFetch?: ProbeFetch } = {},
): Promise<{ line: string; results: AgentProbeResult[] }> {
  const agents = options.agents ?? enumerateActiveAgents(options.agentsRoot);
  const probeFetch = options.probeFetch ?? defaultProbeFetch(options);
  const results: AgentProbeResult[] = [];
  // Sequential — a health check should be gentle on the service, not a thundering herd.
  for (const agent of agents) {
    results.push(await probeAgent(agent, probeFetch));
  }
  return { line: formatCanaryLine(results), results };
}
