#!/usr/bin/env bash
# start-agents-from-launchers.sh — create the agents tmux session using each agent's launch.sh
#
# Usage:
#   ./scripts/start-agents-from-launchers.sh
#   ./scripts/start-agents-from-launchers.sh marcus eli
#   ALLOW_PROTECTED_AGENTS=1 ./scripts/start-agents-from-launchers.sh hercule
#   AGENTS_DIR=/path/to/agents ./scripts/start-agents-from-launchers.sh

set -euo pipefail

TMUX_CONF="${HOME}/.config/mcc-tmux/tmux.conf"
SESSION="${TMUX_SESSION:-agents}"
AGENTS_DIR="${AGENTS_DIR:-/Volumes/Repo-Drive/agents}"
PROTECTED_AGENTS=()

# The roster is DISCOVERED from the launchers, never hardcoded.
#
# It used to be DEFAULT_AGENTS=(marcus isla eli remy lena nova zara jordan val enzo hercule)
# — hand-maintained, and by 2026-08-23 it was stale by four: cecelia, dana, hank and simone
# all had launchers and were all running, and none of them were in that list. Rebuilding the
# session from this script would have silently brought back 11 of 15 agents.
#
# That is the worst shape a latent bug can take: it only fires during a recovery, which is
# precisely when nobody has the attention to notice four agents quietly missing. An agent
# joins the roster by having a launcher, which is the thing that actually defines it.
discover_agents() {
  local dir
  for dir in "${AGENTS_DIR}"/*/; do
    [[ -f "${dir}launch.sh" ]] || continue
    basename "$dir"
  done | sort
}

if [[ $# -gt 0 ]]; then
  AGENTS=("$@")
else
  IFS=$'\n' read -r -d '' -a AGENTS < <(discover_agents && printf '\0')
  # Discovering nothing is indistinguishable from a healthy empty fleet if we let it through,
  # so it is an error rather than a no-op start.
  if [[ ${#AGENTS[@]} -eq 0 ]]; then
    echo "ERROR: no agent launchers found under $AGENTS_DIR — refusing to start an empty session" >&2
    exit 1
  fi
  echo "Discovered ${#AGENTS[@]} agents from launchers: ${AGENTS[*]}"
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
  if [[ "${ALLOW_PROTECTED_AGENTS:-0}" != "1" ]]; then
    for protected_agent in "${PROTECTED_AGENTS[@]}"; do
      if [[ "$agent" == "$protected_agent" ]]; then
        echo "ERROR: '$agent' is protected; set ALLOW_PROTECTED_AGENTS=1 to start it explicitly" >&2
        exit 1
      fi
    done
  fi

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
