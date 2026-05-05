# Open Brain Runtime — Phase 2 Improvements Spec

**Authors:** Isla (draft) + Eli (review)
**Date:** 2026-05-04, revised after Eli sign-off (mailbox `msg_icgps6a8`)
**Status:** APPROVED for implementation, pending Jeremy's go-ahead on phasing
**Owner of implementation:** Eli
**Related commit (Phase 1, already shipped):** `01a1757` on `jeremys-labs/tmux-mcc` main

---

## Eli's revisions (incorporated)

- **Item 1:** keep the existing `claude_prompt` / `discord_reply` grooming branches as legacy compat for one full grooming cycle, then delete. Full replace, no double-write.
- **Item 2:** regex stays for clearly-noise auto_ignore **only**. All promotion decisions must come from the model + thresholds once Item 2 lands. Haiku 4.5, fleet-wide prompt v1.
- **Item 4:** eviction's durable home is behind an OB1 maintenance endpoint, NOT a long-running mcc-tmux script with service-role keys. A temporary report-only dry-run script in mcc-tmux is OK.
- **Item 5:** store the topic in row metadata too (not only in the cluster key) so retrieval/debugging can explain why rows grouped.
- **Item 6 — BLOCKER for Sprint 1:** OB1 currently has `confidence: z.enum(["high","medium","low"])` in `capture_agent_memory`. Sprint 1 cannot emit numeric `0.7` until OB1 accepts numbers. **Decision: patch OB1 schema first** (small change: `z.union([z.number().min(0).max(1), z.enum([...])])` preserving `deriveQualityScore`) to avoid a second capture-writer migration later.
- **Item 7:** definitely an OB1 schema change. Current `canAgentRead` doesn't permit raw_capture reads even via `x-agent-memory-key`, so the path can't replace direct Supabase REST without an OB1-scoped grooming-actor surface. Eviction (Item 4) lives behind the same boundary.
- **Item 8:** `fetchRawCapturesSince` already filters `grooming_status IS NULL`. Repeat-cluster of closed mail means skipped/unmarked rows, not just missing-filter. Durable fix: on mailbox `close`, patch the corresponding raw_capture metadata with both `agent_mail_closed_at` AND a terminal `grooming_status` like `'mail_closed'`. Add the closed_at filter as defense-in-depth.

## Additional acceptance criteria (added by Eli)

- Test that OB1 `capture_agent_memory` accepts numeric confidence **before** mcc-tmux emits it.
- Cross-agent isolation canary: direct `private_agent` prompt capture readable by owner only.
- Idempotent `source_ref`: same source_ref must not create duplicate private context if a hook retries.
- Failure behavior: if direct `private_agent` capture fails, runtime logs and continues — must NOT block the agent turn.

## Eli's clarifications (msg_bl21plho)

- **Sprint 1 is a sequenced two-step in one cycle, not parallel tracks.** Order:
  1. Patch OB1 `capture_agent_memory` schema to accept numeric confidence + legacy strings.
  2. Deploy OB1 and run numeric-confidence canary against the live edge function.
  3. Only after canary passes, switch mcc-tmux writers to numeric + direct `private_agent/context` for `claude_prompt` and `discord_reply`.
  - **No feature flag.** OB1 accepting both shapes is the compatibility boundary; a flag just creates an extra state to maintain and remove.
- **Item 5 — flat `metadata.topic`, normalized slug.** Cluster dimensions live as flat fields (owner_agent, project, source_type, topic, fallback bucket). Topic must be a stable slug like `open-brain-runtime`, `honda-tires` — never arbitrary prose. Normalize Haiku classifier output before storage so grouping is deterministic. If we later want richer classifier diagnostics, add a separate `metadata.classifier = { model, confidence, reason }` object; don't bury the cluster dimension under `cluster_dimensions`.

---

## Goal

Get Open Brain runtime memory to the point where:
1. Every agent's own conversation context is **searchable within seconds**, not hours.
2. The grooming pipeline only touches things that genuinely need review (cross-agent, shared_team, authority elevation, conflict resolution).
3. The system stays bounded (no unbounded `raw_capture` growth) and observable (numeric confidence, not strings).
4. The fork stays as close to upstream NateBJones-Projects/OB1 as possible, with divergences explicit in `UPSTREAM.md`.

## Context

Phase 1 (commit `01a1757`) fixed three classifier defects in `mcc-tmux/packages/server/src/services/open-brain-grooming-review.ts` and shipped a retry-with-backoff for the digest. After the fix, dry-run May 1–5 went from `{private:0, cluster_private:0, needs_review:3}` to `{private:2, cluster_private:8, needs_review:0}`. Memory now lands and surfaces in `answer-context` retrieval.

That said, while debugging the pipeline I found eight further architectural rough edges. This spec proposes designs for each. Items are ordered by user impact, not implementation order.

---

## Item 1 — Skip `raw_capture` round-trip for own-agent context (HIGHEST IMPACT)

### Problem

Every Jeremy → agent prompt and every agent → Discord reply is currently:
1. Captured to `raw_capture` lane with `confidence: 'medium'`, `authority: 'raw_capture'`
2. Sits invisible to `search_agent_memory` (raw_capture is ranked strictly below all other tiers per spec)
3. Waits up to 4 hours for the grooming cron
4. Gets classified, clustered, promoted to `private_agent/context` as a *cluster summary*
5. Original raw_capture rows marked `cluster_promoted` but their content lives only in the summary

This means the agent's own data has a multi-hour visibility lag, and the high-fidelity individual rows are never directly retrievable — only the lossy cluster summary is.

### Proposed Design

**Bypass the buffer for own-agent rows.** The runtime hook captures these as `private_agent/context` directly:

```ts
// captureClaudePromptEvent
await callOpenBrainTool(config, 'capture_agent_memory', {
  agent_id: config.agentId,
  scope: 'private_agent',                  // was: 'raw_capture'
  project: resolveProjectFromCwd(payload), // see Item 3
  audience: [config.agentId],
  authority: 'context',                    // was: 'raw_capture'
  confidence: 0.7,                         // numeric, see Item 6
  source_type: 'claude_prompt',
  source_ref: `claude-prompt:${sessionId}:${promptId}`,
  content: stripInjectedContext(content),  // strip answer_context envelope
});

// captureClaudeHookEvent — Discord reply branch only
if (discordReply) {
  await callOpenBrainTool(config, 'capture_agent_memory', {
    agent_id: config.agentId,
    scope: 'private_agent',                // was: 'raw_capture'
    project: resolveProjectFromCwd(payload),
    audience: [config.agentId],
    authority: 'context',                  // was: 'raw_capture'
    confidence: 0.7,
    source_type: 'discord_reply',
    source_ref: discordReply.sourceRef,
    content,
  });
}
```

Other `claude_hook` events (file edits, tool telemetry, Stop/SessionEnd) **stay in `raw_capture`** — those are debug evidence, not durable memory.

`captureAgentMailMessage` and `captureDiscordInboxEntry` also stay in `raw_capture` since they may contain content from non-allowlisted senders that warrants review before promotion.

### Acceptance Criteria

- [ ] An agent's `search_agent_memory` returns own UserPromptSubmit content within 5 seconds of capture (validated by integration test).
- [ ] Original prompt/reply rows persist as discrete searchable items (not collapsed into cluster summaries).
- [ ] `claude_hook` non-Discord events still flow through `raw_capture` (regression test).
- [ ] Existing grooming classifier branches for `claude_prompt` and `discord_reply` become dead code paths and can be deleted.

### Open Questions for Eli

- Does promoting directly to `private_agent` skip any audit/redaction step in OB1 that `raw_capture` provides? My read of the architecture spec is no — redaction is on capture, not on lane transition — but you'd know better.
- Should we preserve a backup `raw_capture` write for audit, or fully replace? I lean fully replace; double-write is wasted spend and complicates dedupe.

---

## Item 2 — Replace regex classifier with Haiku-backed classifier

### Problem

`classifyRawCapture` is a chain of regex matchers. It misroutes on:
- Substring leaks ("shared_team" appearing inside quoted memory)
- Topic ambiguity (can't distinguish a question from an action item from gossip)
- Multi-language / synonym variations
- Anything subtle that doesn't fit a hardcoded pattern

The OB1 architecture spec already references "classifier confidence" as a real scalar (see `OB1_AGENT_MEMORY_ARCHITECTURE_SPEC.md:225`), but the implementation never produces one.

### Proposed Design

Two-tier classifier:

**Tier 1 — fast-path regex for clearly-noise rows.** Keep the existing transient-acknowledgement and obvious-noise filters. They handle ~30% of volume at zero cost.

**Tier 2 — Haiku call for everything else.** Single LLM call per row that returns:
```json
{
  "action": "auto_promote_private | auto_promote_project | auto_ignore | needs_review",
  "scope": "private_agent | project | shared_team",
  "confidence": 0.0-1.0,
  "topic": "1-3 word topic tag",
  "reason": "one sentence rationale"
}
```

Cost: ~$0.0001/row at Haiku 4.5 pricing. At current volume (~75 raw_captures/day after Item 1 takes own-agent rows out of the buffer), that's **<$0.01/day**.

Use `confidence` to gate promotion: `>= 0.7` auto-promotes; `0.4–0.7` goes to needs_review; `< 0.4` auto-ignored. Threshold tunable via env var.

Use `topic` for cluster keying (see Item 5).

### Acceptance Criteria

- [ ] Classifier accuracy validated against a manually-labeled set of 50 raw captures (Eli + Isla agree on labels).
- [ ] Regex fast-path catches >25% of rows to keep cost down.
- [ ] Confidence is a real number on every row.
- [ ] Daily spend logged and alerted if >$0.50/day.

### Open Questions for Eli

- Haiku 4.5 vs Sonnet 4.6 for classification? I lean Haiku — classification is a low-creativity task and the cost difference is 8×. But you'd be the one paying the latency cost in the cron.
- Do we want a per-agent classifier prompt (so Marcus's classifier knows "code/test/CI is high-signal for me") or a fleet-wide one? I lean fleet-wide v1, per-agent v2.

---

## Item 3 — `project` field needs to be derived, not hardcoded

### Problem

Today every UserPromptSubmit and PostToolUse from every agent is tagged `project: 'agent-runtime'`. That makes project-scoped recall via `search_agent_memory({project: 'frontdesk'})` useless — every conversation lands in the `agent-runtime` bucket.

### Proposed Design

Derive project from cwd resolution at capture time:

```ts
function resolveProjectFromCwd(payload: ClaudeHookPayload): string {
  const cwd = String(payload.cwd ?? '');

  // Repo paths
  const repoMatch = cwd.match(/^\/Volumes\/Repo-Drive\/src\/([^/]+)/);
  if (repoMatch) return repoMatch[1]; // -> "frontdesk", "mcc-tmux", "open-brain"

  // Agent home paths
  const agentMatch = cwd.match(/^\/Volumes\/Repo-Drive\/agents\/([^/]+)/);
  if (agentMatch) return `agent:${agentMatch[1]}`; // -> "agent:isla"

  // Fallback
  return 'agent-runtime';
}
```

`agent-runtime` then means what its name suggests: **true runtime telemetry** (file edits in dotfiles, tool stats, etc.). Conversations land in their actual project bucket.

### Acceptance Criteria

- [ ] Captures from `cwd: /Volumes/Repo-Drive/src/frontdesk/...` get `project: 'frontdesk'`.
- [ ] Captures from `cwd: /Volumes/Repo-Drive/agents/isla` get `project: 'agent:isla'`.
- [ ] `search_agent_memory({project: 'frontdesk'})` returns FrontDesk-only conversations.
- [ ] No regression in agent-mail captures (those already have explicit project).

### Open Questions for Eli

- Should `project: 'agent:<name>'` exist as a distinct namespace, or roll up to one of the cross-cutting projects (newsletter, agent-coordination, etc.)? I lean keeping `agent:<name>` distinct and letting agents override at session start.
- Do we backfill project on existing rows? My recommendation is no — existing data stays, new captures get the better tagging.

---

## Item 4 — `raw_capture` eviction job

### Problem

The architecture spec (`OB1_AGENT_MEMORY_ARCHITECTURE_SPEC.md:428`) declares a hard 30-day TTL on `raw_capture` rows. I don't see a cron that actually evicts them. Table grows unbounded.

### Proposed Design

Daily eviction job at 4:00am (off-peak):
- Delete rows where `metadata.scope = 'raw_capture'` AND `created_at < now() - interval '30 days'` AND `metadata.grooming_status IS NOT NULL` (i.e. already groomed).
- For ungroomed rows older than 30 days, mark them as `grooming_status: 'expired_unreviewed'` rather than delete (audit trail). Sweep those after 60 days.
- Log row count to a metrics table for observability.

Implementation: new script `mcc-tmux/packages/server/src/open-brain-evict-raw-captures.ts`, scheduled in `~/.claude/scheduler/jobs.json` as Eli-owned cron `0 4 * * *`.

### Acceptance Criteria

- [ ] Eviction script dry-run mode shows what would be deleted, run live mode actually deletes.
- [ ] Cron runs daily without producing Discord noise unless deleting >1000 rows (then alerts).
- [ ] `thoughts` table row count plateaus instead of growing linearly.

---

## Item 5 — Cluster key needs a time or topic dimension

### Problem

Current `clusterKey = owner|project|source_type`. Every `claude_prompt` for `isla` collapses into one cluster regardless of topic. Today's cluster contained *Honda Insight tires + Curt Smith tax meeting + Open Brain debugging* in one promoted summary — semantically meaningless for retrieval.

### Proposed Design

Add a topic dimension from the Tier-2 classifier (see Item 2):

```ts
clusterKey = `${owner}|${project}|${sourceType}|${topic}`
// Example: "isla|agent:isla|claude_prompt|honda-insight-tires"
```

Fallback for rows without classifier topics: 2-hour time bucket from `created_at`:
```ts
clusterKey = `${owner}|${project}|${sourceType}|${twoHourBucket}`
// Example: "isla|agent:isla|claude_prompt|2026-05-04T16"
```

Either dimension produces tight, semantically-coherent clusters that embed cleanly.

### Acceptance Criteria

- [ ] Cluster summaries cover one topic, not multi-topic concatenations.
- [ ] Cluster size distribution shifts from "1 huge cluster per agent per day" to "5–15 small focused clusters per agent per day."
- [ ] Retrieval similarity scores on cluster rows go up (validate by re-running canary queries from `open-brain-canary.test.ts`).

---

## Item 6 — `confidence` should be numeric, not string

### Problem

Runtime captures use `confidence: 'medium'` (string). Architecture spec talks about confidence as a 0.0–1.0 scalar with thresholds (e.g. `0.1` floor for raw_capture, `0.7` for promotion). Nothing in the implementation actually compares strings to numeric thresholds — which means classifier confidence is decorative, not functional.

### Proposed Design

Migrate all writers to numeric `confidence`:

| Source                         | Numeric confidence |
|--------------------------------|--------------------|
| `claude_prompt` (own-agent)    | 0.7                |
| `discord_reply` (own-agent)    | 0.7                |
| `claude_hook` (file edit etc.) | 0.3                |
| `agent_mail` (allowlisted)     | 0.6                |
| `discord` (inbound, raw)       | 0.4                |
| Classifier-promoted (Item 2)   | per-row scalar     |

Update `search_agent_memory` ranking to use confidence in retrieval scoring (already does for numeric per spec; verify).

Backwards-compat shim during migration: treat `'low'/'medium'/'high'` strings as `0.3/0.5/0.8` for any read path that hasn't been updated yet.

### Acceptance Criteria

- [ ] All capture writers emit numeric confidence.
- [ ] Promotion threshold is a real comparison.
- [ ] Compat shim deletable after one full grooming cycle (30 days).

---

## Item 7 — Use `x-agent-memory-key` for runtime queries, not service-role key (SECURITY)

### Problem

`open-brain-grooming-digest.ts:resolveOpenBrainRestConfig()` and `open-brain-grooming-review.ts:fetchRawCaptureBySourceRef()` load `SUPABASE_SECRET_KEY` (service-role) from a flat file at `/Volumes/Repo-Drive/src/open-brain/credentials/ob1.env`. That key has full DB access. Every agent process that runs grooming has the keys to the kingdom.

The fork-added `x-agent-memory-key` header path exists specifically to scope access — it's what `capture_agent_memory` and `search_agent_memory` use. The grooming code skips it and goes raw.

### Proposed Design

Add a "grooming actor" identity (`agent_id: 'grooming-bot'`) with its own `agent_memory_key` that has:
- Read access to `raw_capture` rows fleet-wide
- Write access to promote rows (set `grooming_status` metadata)
- No direct delete authority — eviction job uses a separate scoped key

Migrate `fetchRawCapturesSince`, `fetchRawCaptureBySourceRef`, `patchThoughtMetadata` to use the grooming-bot key via the MCP tool surface, not direct Supabase REST.

### Acceptance Criteria

- [ ] No file in `mcc-tmux/` references `SUPABASE_SECRET_KEY` for runtime grooming operations.
- [ ] Grooming queries go through MCP / HTTP with the scoped key.
- [ ] Service-role key lives only in the OB1 edge function, not in mcc-tmux runtime.

### Open Questions for Eli

- Does the OB1 edge function expose a "grooming-bot" privileged path today? If not, this becomes an OB1 schema change too.
- Is the eviction script worth its own scoped key (delete authority), or do we keep eviction in the OB1 edge function?

---

## Item 8 — Closed mailbox messages should not re-cluster

### Problem

`captureAgentMailMessage` writes mail content to `raw_capture` with `source_ref: agent-mail:<msg_id>`. After the mail thread is closed (`closedAt` timestamp), the row still appears in grooming digests on every run. We see the same mail clustered repeatedly.

### Proposed Design

In `fetchRawCapturesSince`, add filter:
```ts
url.searchParams.set('metadata->>agent_mail_closed_at', 'is.null');
```

And update `captureAgentMailMessage` (or a new `closeAgentMailMessage` hook) to set `metadata.agent_mail_closed_at` on the corresponding raw_capture row when the mailbox `close` command runs.

### Acceptance Criteria

- [ ] Closed mailbox threads disappear from grooming after the next close event.
- [ ] Already-closed historical threads get backfilled (one-time sweep).

---

## Phasing (final, post-Eli review)

**Sprint 1 (this week) — runtime + minimal OB1 schema patch:**
1. **OB1 patch first:** widen `capture_agent_memory.confidence` to `z.union([z.number().min(0).max(1), z.enum(["high","medium","low"])])`, preserve `deriveQualityScore` and string-read compat. Ship + verify with a canary.
2. **mcc-tmux Item 1:** direct-write `claude_prompt` + `discord_reply` to `private_agent/context` with numeric confidence 0.7. Keep legacy grooming branches compiled in but unreachable for new captures (delete after one grooming cycle).
3. **mcc-tmux Item 3:** derive `project` from cwd; new rows only.
4. **mcc-tmux Item 6:** migrate writers to numeric confidence per the table in Item 6 below.

**Sprint 2 (next week) — classifier + cluster keys:**
- **Item 2:** two-tier classifier (regex auto_ignore only; Haiku 4.5 owns all promotion decisions) with labeled eval set.
- **Item 5:** topic dimension on cluster keys (from classifier) with 2-hour-bucket fallback; topic also stored in metadata.

**Sprint 3 — OB1 maintenance surface + mcc-tmux migration:**
- **Item 7:** OB1 grooming-actor scoped key + maintenance tool surface, mcc-tmux client migrated off service-role key.
- **Item 4:** eviction behind that maintenance surface (two-stage: groomed→delete at 30d, ungroomed→`expired_unreviewed` at 30d, delete at 60d).
- **Item 8:** mailbox `close` patches raw_capture grooming_status to `'mail_closed'`; add `agent_mail_closed_at` filter as defense-in-depth.

---

## Joint Approval

- **Isla:** drafted the spec ✅
- **Eli:** reviewed end-to-end and signed off with corrections (mailbox `msg_icgps6a8`) ✅
- **Jeremy:** pending green-light on phasing.

Once Jeremy approves the phasing, Eli starts Sprint 1 (OB1 schema patch first, then mcc-tmux Items 1/3/6).

---

## Phase 1 Reference (already shipped)

Commit `01a1757` on `jeremys-labs/tmux-mcc` main:
- Classifier auto-promotes `claude_prompt` and `discord_reply` to `private_agent/context`
- `stripInjectedContext()` removes answer-context boilerplate before pattern matching
- Cluster classifier has matching branch for runtime conversation clusters
- `sendDiscordDigest` retries with backoff on 429
- `--silent-when-clean` flag for tighter cadence without channel noise
- Cron `6c83d8f2…` updated to `30 */4 * * *` with `--silent-when-clean`

114 tests passing. Live verification: 8 isla clusters auto-promoted on the first real run; today's conversation now surfaces in answer-context retrieval.
