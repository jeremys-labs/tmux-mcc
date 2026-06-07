#!/usr/bin/env bash

set -euo pipefail

SESSION="${TMUX_SESSION:-agents}"
AGENTS_DIR="${AGENTS_DIR:-/Volumes/Repo-Drive/agents}"
REPO_ROOT="${MCC_TMUX_ROOT:-/Volumes/Repo-Drive/src/mcc-tmux}"
FORCE_DISRUPTION=0

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <agent> [--force]" >&2
  exit 1
fi

agent="$1"
shift
for arg in "$@"; do
  [[ "$arg" == "--force" ]] && FORCE_DISRUPTION=1
done

source "${REPO_ROOT}/scripts/lib/protect-working.sh"

agent_dir="${AGENTS_DIR}/${agent}"
runtime_file="${agent_dir}/.runtime"
tmux_target="${SESSION}:${agent}"

[[ -d "$agent_dir" ]] || { echo "Agent directory not found: $agent_dir" >&2; exit 1; }
[[ -f "${agent_dir}/launch.sh" ]] || { echo "Launcher not found: ${agent_dir}/launch.sh" >&2; exit 1; }
tmux list-panes -t "$tmux_target" >/dev/null 2>&1 || { echo "tmux target not found: $tmux_target" >&2; exit 1; }

runtime="$(tr -d '\n' < "$runtime_file" 2>/dev/null || true)"
[[ "$runtime" == "claude" || "$runtime" == "codex" ]] || {
  echo "Cannot determine current runtime for $agent" >&2
  exit 1
}

protect_working_check "$agent" "$FORCE_DISRUPTION"

echo "Restarting $agent on $runtime via $tmux_target"
tmux set-option -p -t "$tmux_target" remain-on-exit on
tmux send-keys -t "$tmux_target" "/exit" Enter

for _ in $(seq 1 40); do
  if tmux display-message -p -t "$tmux_target" '#{pane_dead}' 2>/dev/null | grep -q '^1$'; then
    break
  fi
  sleep 0.5
done

tmux respawn-pane -k -t "$tmux_target" -c "$agent_dir" "./launch.sh --runtime $runtime"
tmux set-option -p -u -t "$tmux_target" remain-on-exit

for _ in $(seq 1 60); do
  if curl -fsS "${AGENT_SUPERVISOR_URL:-http://127.0.0.1:4318}/v1/agents" \
    | jq -e --arg agent "$agent" '.agents[] | select(.agent == $agent and .process.status == "running")' \
    >/dev/null; then
    echo "Restarted: $agent ($runtime)"
    exit 0
  fi
  sleep 1
done

echo "Agent did not return healthy within 60 seconds: $agent" >&2
exit 1
