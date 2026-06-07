# ADR 0002: Agent Process Topology and Lifecycle

Status: Accepted

## Decision

The operating-system service manager supervises durable daemons:

```text
OS service manager
  agent-comms
  agent-memory
  agent-supervisor
    runtime sessions and scheduler
  mcc-tmux
```

`agent-skills`, `agent-harness`, and runtime adapters begin as packages loaded
by `agent-supervisor`. MCC is not a process manager.

Every daemon exposes health and readiness, emits structured logs, persists
durable state outside its process, and survives independent restarts.
Supervisor commands are idempotent and desired state is reconciled after a
restart.

Runtime health includes progress health, not only process liveness. The
supervisor must detect hung-but-alive sessions using turn age, queued work,
heartbeat/progress events, and bounded recovery policy.

## Failure Behavior

- A memory outage must not hang or reject an agent turn.
- Degraded turns proceed with a visible `memory unavailable` marker.
- A failed memory request is not represented as an empty successful result.
- Clients reconnect after an `agent-memory` restart without requiring a fleet
  restart.
- MCC displays degraded service states but does not attempt to become their
  supervisor.

## Migration Policy

Cross-process migrations use compatibility modes:

1. Embedded behavior remains authoritative.
2. A shadow client compares service output against embedded output.
3. Operators inspect parity and failure telemetry.
4. The service becomes authoritative with embedded fallback available for a
   bounded rollback window.
5. Embedded ownership is removed only after independent restart and MCC-offline
   tests pass.

Long-lived runtime sessions may retain old hook code until restart. Changes
must remain backward compatible during that window or include an explicit
coordinated fleet roll.
