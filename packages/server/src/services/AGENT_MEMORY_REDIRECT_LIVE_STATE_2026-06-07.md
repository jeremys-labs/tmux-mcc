# Agent-memory redirect — live-fleet state investigation (2026-06-07 ~01:00 ET)

**Author:** Eli (Opus). **For:** Isla, before she runs the supervised daylight cutover.
**Gating question (Isla):** are agents really routing recall through the `:4317`
agent-memory service right now, or effectively still on embedded despite
`MODE=service` in env? What was actually serving recall before `362f04f`?

## Answer

**The live fleet is effectively on EMBEDDED recall (direct OB1), NOT the service.**
The redirect is **env-deep only — not active end-to-end.** No live agent process
is confirmably routing recall through `:4317`.

## Evidence

### 1. The env flag predates the code that honors it
- `AGENT_MEMORY_SERVICE_MODE=service` is injected into every agent runtime by
  `runtime-launch-plan.ts` (`SERVICE_MEMORY_ENV`), added in commit `99bc78e`
  ("Cut fleet over to memory and skills services") — **before tonight**.
- The runtime code that actually *acts* on `serviceMode` —
  `callOpenBrainTool`'s `if (config.serviceMode === 'service') return callAgentMemoryServiceTool(...)`
  branch in `open-brain-runtime.ts` — was **added in `362f04f`** (committed
  `2026-06-07 00:25:21`). `git show 362f04f -- open-brain-runtime.ts` confirms
  the serviceUrl/serviceMode/service-branch lines are all `+` additions.
- **Conclusion:** before `362f04f`, the routing branch did not exist. The env
  flag was inert. Recall went straight to OB1 (embedded) unconditionally.

### 2. Every running agent process predates `362f04f`
- All agent runtimes (claude/codex + wrappers) started in the **23:39–23:41 Jun 6**
  fleet boot — ~45 min *before* `362f04f` (00:25 Jun 7). A Node process runs the
  code it loaded at startup; rebuilding dist on disk does not change a running
  process. So the live fleet is running pre-`362f04f` code with **no service
  branch**, regardless of the `MODE=service` env they carry.
- No agent process started after `362f04f` (00:25) or after the dist rebuild
  (00:47). Verified by per-process `lstart`.

### 3. The service's own logs show no live fleet traffic
- `agent-memory.log` (stdout): only 4 `listening on` startup lines. (Note: the
  service does not log successful requests, so this is corroborating, not
  decisive on its own.)
- `agent-memory.err.log`: 11 stale errors, file mtime **23:36:52 Jun 6** — before
  the current service instance even started (pid 55234 @ 00:10:46 Jun 7). They
  are one-per-other-agent ("Agent key for `<isla|marcus|remy|lena|nova|jordan|val|enzo|hercule|zara|hank>` cannot act as `eli`")
  — the **isolation-canary signature** (cross-agent access correctly denied),
  not live recall. The current service instance has logged nothing.
- A read-only probe (`POST /v1/tool` `agentKey=eli search_agent_memory`) returned
  correct **eli-scoped** results → the service itself works and enforces per-agent
  isolation. It is simply not being exercised by the live fleet.

### 4. CONTENT_ROOT picture (per layer)
- Live mcc-tmux server (pid 19877): `CONTENT_ROOT=/Users/jeremylahners/.tmux-mcc`,
  no `AGENT_MEMORY_SERVICE_*` env of its own. Start script
  `~/.local/bin/start-mcc-tmux-server.sh` exports `.tmux-mcc` (reboot-durable).
  The 2026-06-04 content-root cutover holds.
- Inner agent runtimes: `CONTENT_ROOT=.tmux-mcc` (set explicitly by the launch
  plan) + `AGENT_MEMORY_SERVICE_URL=:4317` + `MODE=service`.
- Outer `runtime-launch`/npm shim processes: `CONTENT_ROOT=.openclaw` (inherited
  from the boot/poller env). Cosmetic — these only spawn the inner runtime; the
  inner runtime that does recall is `.tmux-mcc`. Worth a tidy-up but not a
  correctness issue for memory.

## One caveat, explicitly

The only way a running agent could already be on service mode is if dist had been
built from Marcus's *uncommitted* service code before the 23:39 boot. That
contradicts the "uncommitted, never pushed" account that triggered tonight's
push. Either way it is moot: the supervised relaunch on committed code is what
actually activates the redirect, so it gets resolved by doing the cutover
cleanly.

## Implication for the cutover

Tonight's "MODE=service everywhere" is **not** an active cutover — it is a staged
env waiting for a relaunch on `≥362f04f` code. That is good: it means the flip is
still entirely in your hands and nothing silently changed agent memory behavior.

**Recommended (you own the window + soak):**
1. Deploy this branch; set harness `AGENT_MEMORY_SERVICE_MODE=shadow`; relaunch
   the fleet. Embedded stays authoritative; the service is called fire-and-forget
   and retrieval parity is logged to
   `/Volumes/Repo-Drive/agents/SHARED/agent-memory-shadow.jsonl`.
2. Validate parity via `shadow-report` (in `@agent-system/agent-memory`). When
   clean, flip env `shadow → service`, relaunch, soak.
3. Make both env values reboot-durable in `start-mcc-tmux-server.sh` (or the
   boot env), not just the running process.
Rollback at any point: unset `AGENT_MEMORY_SERVICE_URL` (→ embedded) or revert
the env value, relaunch.

The `shadow-first` staging requires the launch-plan override shipped on this
branch (`eli/stage-memory-service-redirect`); without it the launch plan forces
`service` and there is no safe intermediate.
