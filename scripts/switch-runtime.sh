#!/usr/bin/env bash

set -euo pipefail

SESSION="${TMUX_SESSION:-agents}"
AGENTS_DIR="${AGENTS_DIR:-/Volumes/Repo-Drive/agents}"

if [[ $# -lt 2 ]]; then
  echo "Usage: $0 <agent> <claude|codex> [reason...]" >&2
  exit 1
fi

if [[ "${DETACHED:-}" != "1" ]]; then
  agent="$1"
  target="$2"
  log_file="/tmp/switch-runtime-${agent}.log"
  echo "Detaching switch request for $agent to $target: $log_file"
  DETACHED=1 nohup bash "$0" "$@" >"$log_file" 2>&1 &
  exit 0
fi

agent="$1"
target="$2"
shift 2
reason="${*:-user requested}"

case "$target" in
  claude|codex) ;;
  *)
    echo "Unsupported target runtime: $target" >&2
    exit 1
    ;;
esac

agent_dir="${AGENTS_DIR}/${agent}"
launcher="${agent_dir}/launch.sh"
handoff_file="${agent_dir}/.runtime-handoff.md"
runtime_file="${agent_dir}/.runtime"
tmux_target="${SESSION}:${agent}"
repo_root="${MCC_TMUX_ROOT:-/Volumes/Repo-Drive/src/mcc-tmux}"

if [[ ! -d "$agent_dir" ]]; then
  echo "Agent directory not found: $agent_dir" >&2
  exit 1
fi
if [[ ! -f "$launcher" ]]; then
  echo "Launcher not found: $launcher" >&2
  exit 1
fi

current_runtime="${LAUNCH_RUNTIME:-}"
if [[ -z "$current_runtime" && -f "$runtime_file" ]]; then
  current_runtime="$(tr -d '\n' < "$runtime_file")"
fi
if [[ -z "$current_runtime" ]]; then
  current_runtime="$(
    grep -oE 'LAUNCH_RUNTIME="\$\{LAUNCH_RUNTIME:-([^"]+)\}"' "$launcher" \
      | sed -E 's/.*:-([^"}]+).*/\1/' \
      | head -n 1
  )"
fi
if [[ -z "$current_runtime" ]]; then
  current_runtime="claude"
fi

if [[ "$current_runtime" == "$target" ]]; then
  echo "Already on $target for $agent"
  exit 0
fi

if ! tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "tmux session not found: $SESSION" >&2
  exit 1
fi

if ! tmux list-panes -t "$tmux_target" >/dev/null 2>&1; then
  echo "tmux target not found: $tmux_target" >&2
  exit 1
fi

echo "Switching $agent to $target via $tmux_target"

handoff_path="$(
  npm run runtime-handoff \
    --workspace=@mcc-tmux/server \
    --prefix "$repo_root" \
    -- \
    create \
    --agent "$agent" \
    --from-runtime "$current_runtime" \
    --to-runtime "$target" \
    --workspace "$agent_dir" \
    --reason "$reason" \
    | tail -n 1
)"
echo "Prepared handoff: $handoff_path"

# Keep the pane alive after the current runtime exits so we can respawn it.
tmux set-option -p -t "$tmux_target" remain-on-exit on

tmux send-keys -t "$tmux_target" "/exit" Enter

# Wait (up to 30s) for the pane to enter dead state, meaning the runtime has exited.
for _ in $(seq 1 60); do
  if tmux display-message -p -t "$tmux_target" '#{pane_dead}' 2>/dev/null | grep -q '^1$'; then
    break
  fi
  sleep 0.5
done

# Note: `.runtime` is owned by launch.sh (written when a runtime actually starts),
# so we do not write it here. Writing it pre-relaunch caused stale-state bugs when
# the relaunch failed.

# Respawn the pane with the new runtime. -k kills any leftover process if the pane
# isn't actually dead yet (e.g. /exit was ignored). -c sets the working directory.
tmux respawn-pane -k -t "$tmux_target" -c "$agent_dir" "./launch.sh --runtime $target"

# Restore default behavior so a future crash doesn't leave a zombie pane.
tmux set-option -p -u -t "$tmux_target" remain-on-exit
