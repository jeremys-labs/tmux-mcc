#!/usr/bin/env bash

set -euo pipefail

AGENTS_DIR="${AGENTS_DIR:-/Volumes/Repo-Drive/agents}"
SUPERVISOR_URL="${AGENT_SUPERVISOR_URL:-http://127.0.0.1:4318}"

if [[ $# -lt 2 ]]; then
  echo "Usage: $0 <agent> <claude|codex> [--force] [reason...]" >&2
  exit 1
fi

if [[ "${DETACHED:-}" != "1" ]]; then
  agent="$1"
  target="$2"
  log_file="/tmp/switch-runtime-${agent}.log"
  echo "Detaching supervisor switch request for $agent to $target: $log_file"
  DETACHED=1 nohup bash "$0" "$@" >"$log_file" 2>&1 &
  exit 0
fi

agent="$1"
target="$2"
shift 2
force_disruption=0
reason_parts=()
for arg in "$@"; do
  if [[ "$arg" == "--force" ]]; then
    force_disruption=1
  else
    reason_parts+=("$arg")
  fi
done
reason="${reason_parts[*]:-user requested}"

case "$target" in
  claude|codex) ;;
  *)
    echo "Unsupported target runtime: $target" >&2
    exit 1
    ;;
esac

[[ -d "${AGENTS_DIR}/${agent}" ]] || {
  echo "Agent directory not found: ${AGENTS_DIR}/${agent}" >&2
  exit 1
}

request_id="switch-${agent}-${target}-$(date +%s)-$$"
body="$(
  jq -cn \
    --arg requestId "$request_id" \
    --arg agent "$agent" \
    --arg runtime "$target" \
    --arg reason "$reason" \
    --argjson force "$([[ "$force_disruption" == "1" ]] && echo true || echo false)" \
    '{requestId: $requestId, operation: "switch-runtime", agent: $agent, runtime: $runtime, reason: $reason, force: $force}'
)"
response_file="$(mktemp)"
trap 'rm -f "$response_file"' EXIT

http_status="$(
  curl --silent --show-error --output "$response_file" --write-out '%{http_code}' \
    -X POST "${SUPERVISOR_URL}/v1/commands" \
    -H 'content-type: application/json' \
    --data "$body" || true
)"

if [[ "$http_status" == "200" ]]; then
  jq -r '"Runtime switch: \(.agent) -> \(.runtime) (\(.status)) via agent-supervisor"' "$response_file"
  exit 0
fi

detail="$(jq -r '.detail // .error // "agent-supervisor unavailable"' "$response_file" 2>/dev/null || cat "$response_file")"
echo "REFUSED: supervisor runtime switch for $agent failed: $detail" >&2
[[ "$http_status" == "409" ]] && echo "Pass --force only with Jeremy's explicit override." >&2
exit 1
