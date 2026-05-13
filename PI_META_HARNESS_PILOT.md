# Pi Meta-Harness Pilot

## Recommendation

Use Enzo to pilot a Pi-style meta-harness above the existing Claude and Codex wrappers. Do not embed Pi SDK into the fleet yet.

OpenClaw's useful pattern is not "replace every native runtime." It is:

```text
control plane / channels / policy
-> stable runtime session API
-> runtime adapters
-> model/tool execution
```

For MCC, the pilot equivalent is:

```text
Enzo launch.sh
-> runtime-launch plan
-> claude-wrapper | codex-wrapper adapter
-> native Claude/Codex CLI
```

## Pilot Scope

The Enzo pilot adds a reusable runtime launch planner with two adapters:

- `claude`: injects the Discord Claude channel plugin and agent-specific `DISCORD_STATE_DIR`
- `codex`: forwards Codex flags after the wrapper separator and sets the shared `CONTENT_ROOT`

The existing wrappers still own runtime-specific behavior: PTY interaction, answer-context injection, OB1 capture, Discord inbox handling, agent-mail polling, and runtime handoff consumption.

## Phase 1 Readiness Gate

The Enzo canary proved that "the runtime starts" is not enough. A runtime adapter is ready only when all surfaces that make the agent usable move with it:

```text
agent launcher selects the requested runtime
runtime wrapper process is active
inbound Discord bridge binding is active when the agent has Discord channels
outbound Discord MCP server is available when the agent has Discord channels
OB1 .open-brain/memory.env exists
OB1 endpoint allowlists the agent and accepts search_agent_memory
startup recall is active
answer-context/capture is active
local memory files are imported or intentionally left local
```

Enzo exposed three concrete misses:

- Codex launched, but no Enzo-specific inbound Discord bridge was resident.
- Discord injected after the bridge was started, but Codex lacked `discord-enzo` outbound MCP, so replies failed.
- Claude/Codex both had local Enzo files, but Enzo had no OB1 identity or allowed-agent entry, so runtime-neutral memory was disabled.

Those are adapter-completeness failures, not model failures.

## Why This Is The Right First Step

This tests the control-plane boundary without changing agent behavior. If Enzo starts cleanly through the planner, we can move the launch planner into the broader switch-runtime path and then decide whether to add a true Pi adapter.

It also gives us a concrete place to attach future runtime capabilities:

- runtime selection
- launch-plan validation
- shared environment normalization
- per-agent runtime policy
- dry-run/debug output
- future `pi` adapter when the binary/package is installed outside OpenClaw

## Explicit Non-Goals

- Do not rewrite the Claude/Codex wrappers in this pilot.
- Do not make Pi a hard dependency for active agents.
- Do not change Enzo's persona, memory, curriculum, TTS, or Discord routing.
- Do not move scheduler or mcc-tmux fleet control into Pi.

## Test Bar

- Unit tests prove the Enzo Claude and Codex launch plans exactly match the current launcher behavior.
- CLI dry-run prints the Enzo plan without spawning a runtime.
- `runtime-health` flags partial Codex readiness: missing inbound bridge, missing outbound Discord MCP, missing OB1 key, or OB1 endpoint rejection.
- Build passes.

## Next Migration Rule

Do not migrate a busy agent on the strength of a successful launch alone. Run the health check first and require the agent's runtime, Discord, and OB1 checks to be green or explicitly waived.

Use the gate directly:

```bash
npm run open-brain:runtime-health --workspace=@mcc-tmux/server --prefix /Volumes/Repo-Drive/src/mcc-tmux -- --agents enzo --require-migration-ready
```
