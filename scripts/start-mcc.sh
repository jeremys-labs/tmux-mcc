#!/usr/bin/env bash
# start-mcc.sh — Start everything: agents session + MCC server + MCC client
#
# Usage:
#   ./scripts/start-mcc.sh              # start all components
#   ./scripts/start-mcc.sh --no-agents  # skip agent session (already running)

set -euo pipefail

MCC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER_PORT="${SERVER_PORT:-8083}"
LOG_DIR="${MCC_DIR}/logs"

mkdir -p "$LOG_DIR"

START_AGENTS=true
for arg in "$@"; do
  [[ "$arg" == "--no-agents" ]] && START_AGENTS=false
done

echo "=== MCC Startup ==="
echo "Dir:    $MCC_DIR"
echo "Port:   $SERVER_PORT"
echo ""

# ─── Agent session ──────────────────────────────────────────────────────────
# start-agents.sh lives outside the repo (agent-specific config)
# Default: look in the parent of the MCC repo, or set AGENTS_SCRIPT env var
AGENTS_SCRIPT="${AGENTS_SCRIPT:-$(dirname "$MCC_DIR")/agents/start-agents.sh}"

if $START_AGENTS; then
  if [[ ! -f "$AGENTS_SCRIPT" ]]; then
    echo "WARN: start-agents.sh not found at $AGENTS_SCRIPT — skipping agent session"
    echo "      Set AGENTS_SCRIPT=/path/to/start-agents.sh to override"
  else
    echo "→ Starting agent session..."
    bash "$AGENTS_SCRIPT"
    echo ""
  fi
fi

# ─── Server ─────────────────────────────────────────────────────────────────
if lsof -ti:"$SERVER_PORT" &>/dev/null; then
  echo "→ Server already running on :$SERVER_PORT"
else
  echo "→ Starting server on :$SERVER_PORT..."
  SERVER_PORT="$SERVER_PORT" npm run --prefix "$MCC_DIR" --workspace=packages/server dev \
    > "${LOG_DIR}/server.log" 2>&1 &
  SERVER_PID=$!
  echo "  PID: $SERVER_PID (log: logs/server.log)"

  # Wait for server to be ready
  for i in {1..20}; do
    if curl -sf "http://localhost:${SERVER_PORT}/api/health" &>/dev/null; then
      echo "  Ready ✓"
      break
    fi
    sleep 0.5
  done
fi

echo ""

# ─── Client ─────────────────────────────────────────────────────────────────
CLIENT_PORT=3001
if lsof -ti:"$CLIENT_PORT" &>/dev/null; then
  echo "→ Client already running on :$CLIENT_PORT"
else
  echo "→ Starting client on :$CLIENT_PORT..."
  npm run --prefix "$MCC_DIR" --workspace=packages/client dev \
    > "${LOG_DIR}/client.log" 2>&1 &
  CLIENT_PID=$!
  echo "  PID: $CLIENT_PID (log: logs/client.log)"
  sleep 2
fi

echo ""

# ─── Summary ────────────────────────────────────────────────────────────────
TAILSCALE_IP=$(tailscale ip -4 2>/dev/null || echo "")
echo "=== Ready ==="
echo "  Local:     http://localhost:$CLIENT_PORT"
[[ -n "$TAILSCALE_IP" ]] && echo "  Tailscale: http://${TAILSCALE_IP}:$CLIENT_PORT"
echo ""
echo "  Agents:    curl http://localhost:$SERVER_PORT/api/terminal/agents"
echo "  Logs:      tail -f $MCC_DIR/logs/server.log"
