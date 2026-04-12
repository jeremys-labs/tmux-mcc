#!/usr/bin/env bash
# start-agents.sh — Create the agents tmux session using the MCC tmux config
#
# Each agent gets a named window running `claude` in their work directory.
# Agents without a work directory are skipped with a warning.
#
# Usage:
#   ./scripts/start-agents.sh            # start all configured agents
#   ./scripts/start-agents.sh marcus eli  # start specific agents only
#   AGENTS_DIR=/my/path ./scripts/start-agents.sh

set -euo pipefail

TMUX_CONF="${HOME}/.config/mcc-tmux/tmux.conf"
SESSION="agents"
AGENTS_DIR="${AGENTS_DIR:-/Volumes/Repo-Drive/agents}"

# Agents to start (in order — first becomes the initial window)
# Override by passing agent names as arguments: ./start-agents.sh marcus isla
DEFAULT_AGENTS=(marcus isla harper eli sage remy lena nova zara)

if [[ $# -gt 0 ]]; then
  AGENTS=("$@")
else
  AGENTS=("${DEFAULT_AGENTS[@]}")
fi

# ─── Check prerequisites ────────────────────────────────────────────────────
if ! command -v tmux &>/dev/null; then
  echo "ERROR: tmux not found" >&2; exit 1
fi

if [[ ! -f "$TMUX_CONF" ]]; then
  echo "ERROR: tmux config not found at $TMUX_CONF" >&2; exit 1
fi

# ─── Session already exists? ────────────────────────────────────────────────
if tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "Session '$SESSION' already exists."
  echo "To rebuild it: tmux kill-session -t $SESSION && $0"
  exit 0
fi

# ─── Build the session ──────────────────────────────────────────────────────
FIRST=true
for agent in "${AGENTS[@]}"; do
  work_dir="${AGENTS_DIR}/${agent}"

  if [[ ! -d "$work_dir" ]]; then
    echo "SKIP: no work dir for '$agent' (expected $work_dir)"
    continue
  fi

  if $FIRST; then
    # Create the session with the first agent as the initial window
    tmux -f "$TMUX_CONF" new-session -d -s "$SESSION" -n "$agent" -c "$work_dir"
    tmux -f "$TMUX_CONF" send-keys -t "${SESSION}:${agent}" "claude" Enter
    FIRST=false
  else
    tmux -f "$TMUX_CONF" new-window -t "$SESSION" -n "$agent" -c "$work_dir"
    tmux -f "$TMUX_CONF" send-keys -t "${SESSION}:${agent}" "claude" Enter
  fi

  echo "Started: $agent ($work_dir)"
done

if $FIRST; then
  echo "ERROR: no valid agent directories found under $AGENTS_DIR" >&2
  exit 1
fi

echo ""
echo "Session '$SESSION' ready — $(tmux list-windows -t $SESSION | wc -l | tr -d ' ') agents"
tmux list-windows -t "$SESSION" -F "  #I: #{window_name}"
