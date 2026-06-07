# ADR 0001: Agent System Ownership Boundaries

Status: Accepted

## Decision

The agent system is divided into explicit ownership boundaries:

- `agent-comms` owns message envelopes, addressing, delivery, retries, routing,
  channel adapters, and communication history.
- `agent-memory` owns memory ingestion, retrieval, retention, indexing,
  restricted-memory governance, and the authenticated boundary to memory
  storage engines.
- `agent-skills` owns canonical skill manifests, versions, scopes, discovery,
  matching, and runtime-neutral resolution. Runtime adapters own projection
  into Claude, Codex, Pi, or future runtime-specific prompt/tool surfaces.
- `agent-harness` owns runtime-neutral session and context-provider contracts.
- Runtime adapters own Claude, Codex, Pi, or future runtime-specific behavior.
- `agent-supervisor` owns desired session state, lifecycle reconciliation,
  runtime health, crash recovery, and operator commands.
- `mcc-tmux` owns web serving, operator UI, file/terminal viewing, and service
  API clients.

The harness, not `agent-memory`, composes final answer context. Answer context is
cross-cutting and may include memory, communications state, skills, clock, and
other domain providers.

The scheduler is durable agent behavior. It is owned by `agent-supervisor`
until scale or isolation requirements justify a separate scheduler service.

Agent identity and service credentials are owned by the control plane and
enforced at every service boundary. A caller-provided agent name is a routing
hint, not proof of identity. Memory engines must derive authorization from
service-held per-agent credentials.

## Dependency Rules

- No service or runtime adapter imports `mcc-tmux`.
- Runtime adapters do not query Open Brain, Discord, or other durable systems
  directly. They use harness provider contracts.
- MCC does not mutate service-owned storage or implement durable agent
  behavior.
- Memory and communication failures are explicit. They never silently appear
  as valid empty results.
- Restricted memory is classify-at-ingest and deny-by-default on every read,
  export, projection, and administrative path.

## Consequences

MCC can be stopped or deployed without stopping agents. Runtime choice becomes
an adapter decision rather than a system rewrite. Package ownership does not
imply that every package is a long-running service.
