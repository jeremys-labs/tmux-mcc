# OB1 Harness Boundaries

This document defines the ownership boundary for the OB1 pilot work so the local control plane does not become the long-term home for reusable memory and domain logic.

## Recommendation

Keep `mcc-tmux` as Jeremy's local control plane. Move reusable hook behavior toward a shared harness layer once the pilot stabilizes. Keep governed memory and domain extensions in Open Brain, and keep transport primitives in `agent-comms`.

## Ownership

### Open Brain

Open Brain owns the memory substrate and domain extension systems of record:

- governed memory tools such as `search_agent_memory` and `capture_agent_memory`
- scoped lanes, access policies, per-agent memory keys, and grooming policy
- schemas and extension tables for structured domains
- domain MCP servers such as meal planning, CRM, household knowledge, and future agent-specific extensions

Open Brain should store durable memories, provenance, source-of-truth shared/project context, and structured domain state. For Remy, the meal-planning extension is the right starting point for recipes, meal plans, shopping lists, and current dated meal state.

### Shared Harness Layer

The shared harness layer owns reusable runtime behavior:

- reading Claude Code and Codex hook payloads
- inferring the active agent from `cwd` or environment
- formatting runtime-specific hook output
- running startup recall and answer-time context retrieval
- enforcing context authority rules such as current domain state outranking stale imported history
- providing an adapter interface for domain state lookups

The current pilot implementation lives in `mcc-tmux` under `packages/server/src/services`, but the long-term home should be a small reusable harness package or Open Brain integration folder that can be invoked by both Claude Code and Codex hooks.

### agent-comms

`agent-comms` owns reusable communication primitives:

- mailbox data model and APIs
- Discord bridge behavior
- reusable message envelopes and transport helpers

`mcc-tmux` may configure and run these primitives locally, but it should not own their general behavior.

### mcc-tmux

`mcc-tmux` owns Jeremy's local orchestration:

- roster, environment discovery, and agent process launch policy
- tmux/PTY wrapper integration
- local Discord and agent-mail injection into running agents
- scheduler jobs, launchd wiring, logs, canaries, and verification commands
- local hook installation and fleet configuration

`mcc-tmux` can host pilot glue while proving the integration, but reusable memory semantics and domain systems should move out once their contracts are stable.

## Current Pilot Placement

The pilot currently uses these `mcc-tmux` files:

- `packages/server/src/open-brain-hook.ts`: thin CLI entrypoint for Claude/Codex hook execution
- `packages/server/src/services/open-brain-harness-hook.ts`: reusable hook runner and runtime output formatting
- `packages/server/src/services/open-brain-runtime.ts`: OB1 credential resolution and JSON-RPC calls
- `packages/server/src/services/answer-context.ts`: answer-time context builder and initial domain adapters
- `packages/server/src/codex-wrapper.ts`: mcc-tmux-specific PTY injection for Discord and agent-mail
- `packages/server/src/claude-wrapper.ts`: mcc-tmux-specific PTY injection for agent-mail

The wrapper integrations are intentionally `mcc-tmux` specific. The hook runner and answer-context contract are candidates for extraction after the Eli/Isla pilot and Remy/Lena domain pilots are verified.

## Migration Rule

Before migrating another agent, define:

1. The agent's allowed OB1 lanes.
2. Any domain extension tables or external systems of record.
3. The answer-time adapter that retrieves current state before semantic memory.
4. The provenance mapping between memory records and structured rows/files.
5. A canary proving private-lane segregation and relevant answer-time recall.

Do not import domain history as flat memory when a structured extension exists or is clearly needed.
