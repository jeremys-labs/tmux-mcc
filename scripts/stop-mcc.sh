#!/usr/bin/env bash
# stop-mcc.sh — Stop the MCC server and client
# Does NOT kill the agent tmux session (agents keep running)
#
# Usage:
#   ./scripts/stop-mcc.sh              # stop server + client only
#   ./scripts/stop-mcc.sh --all        # also kill the agents tmux session

set -euo pipefail

KILL_AGENTS=false
for arg in "$@"; do
  [[ "$arg" == "--all" ]] && KILL_AGENTS=true
done

echo "=== MCC Shutdown ==="

# ─── Kill server ────────────────────────────────────────────────────────────
SERVER_PORT="${SERVER_PORT:-8083}"
if lsof -ti:"$SERVER_PORT" &>/dev/null; then
  kill "$(lsof -ti:"$SERVER_PORT")" 2>/dev/null && echo "→ Server stopped (:$SERVER_PORT)"
else
  echo "→ Server not running"
fi

# ─── Kill client ────────────────────────────────────────────────────────────
CLIENT_PORT=3001
if lsof -ti:"$CLIENT_PORT" &>/dev/null; then
  kill "$(lsof -ti:"$CLIENT_PORT")" 2>/dev/null && echo "→ Client stopped (:$CLIENT_PORT)"
else
  echo "→ Client not running"
fi

# ─── Kill agent session (optional) ──────────────────────────────────────────
if $KILL_AGENTS; then
  if tmux has-session -t agents 2>/dev/null; then
    tmux kill-session -t agents && echo "→ Agent session killed"
  else
    echo "→ No agent session running"
  fi
fi

echo "Done."
