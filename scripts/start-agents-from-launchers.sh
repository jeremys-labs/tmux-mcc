#!/usr/bin/env bash
# start-agents-from-launchers.sh — create the agents tmux session using each agent's launch.sh
#
# Usage:
#   ./scripts/start-agents-from-launchers.sh
#   ./scripts/start-agents-from-launchers.sh marcus eli
#   AGENTS_DIR=/path/to/agents ./scripts/start-agents-from-launchers.sh

set -euo pipefail

TMUX_CONF="${HOME}/.config/mcc-tmux/tmux.conf"
SESSION="${TMUX_SESSION:-agents}"
AGENTS_DIR="${AGENTS_DIR:-/Volumes/Repo-Drive/agents}"
DEFAULT_AGENTS=(marcus isla harper eli sage remy lena nova zara jordan enzo hercule)

if [[ $# -gt 0 ]]; then
  AGENTS=("$@")
else
  AGENTS=("${DEFAULT_AGENTS[@]}")
fi

if ! command -v tmux &>/dev/null; then
  echo "ERROR: tmux not found" >&2
  exit 1
fi

if [[ ! -f "$TMUX_CONF" ]]; then
  echo "ERROR: tmux config not found at $TMUX_CONF" >&2
  exit 1
fi

if tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "Session '$SESSION' already exists."
  echo "To rebuild it: tmux kill-session -t $SESSION && $0"
  exit 0
fi

launch_cmd_for() {
  local work_dir="$1"
  local launcher="$work_dir/launch.sh"

  if [[ -f "$launcher" ]]; then
    printf 'zsh %q' "$launcher"
    return
  fi

  printf 'claude --dangerously-skip-permissions'
}

runtime_for() {
  local work_dir="$1"
  local launcher="$work_dir/launch.sh"

  if [[ -f "$launcher" ]]; then
    local default_runtime
    default_runtime="$(
      grep -oE 'LAUNCH_RUNTIME="\$\{LAUNCH_RUNTIME:-([^"]+)\}"' "$launcher" \
        | sed -E 's/.*:-([^"}]+).*/\1/' \
        | head -n 1
    )"
    if [[ "$default_runtime" == "claude" || "$default_runtime" == "codex" ]]; then
      printf '%s\n' "$default_runtime"
      return
    fi
  fi

  printf 'claude\n'
}

FIRST=true
for agent in "${AGENTS[@]}"; do
  work_dir="${AGENTS_DIR}/${agent}"

  if [[ ! -d "$work_dir" ]]; then
    echo "SKIP: no work dir for '$agent' (expected $work_dir)"
    continue
  fi

  launch_cmd="$(launch_cmd_for "$work_dir")"
  runtime="$(runtime_for "$work_dir")"
  printf '%s\n' "$runtime" > "$work_dir/.runtime"

  if $FIRST; then
    tmux -f "$TMUX_CONF" new-session -d -s "$SESSION" -n "$agent" -c "$work_dir"
    tmux -f "$TMUX_CONF" send-keys -t "${SESSION}:${agent}" "$launch_cmd" Enter
    FIRST=false
  else
    tmux -f "$TMUX_CONF" new-window -t "$SESSION" -n "$agent" -c "$work_dir"
    tmux -f "$TMUX_CONF" send-keys -t "${SESSION}:${agent}" "$launch_cmd" Enter
  fi

  echo "Started: $agent ($work_dir) -> $launch_cmd"
done

if $FIRST; then
  echo "ERROR: no valid agent directories found under $AGENTS_DIR" >&2
  exit 1
fi

echo ""
echo "Session '$SESSION' ready — $(tmux list-windows -t "$SESSION" | wc -l | tr -d ' ') agents"
tmux list-windows -t "$SESSION" -F "  #I: #{window_name}"
