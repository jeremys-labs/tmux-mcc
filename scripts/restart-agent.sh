#!/usr/bin/env bash

set -euo pipefail

AGENTS_DIR="${AGENTS_DIR:-/Volumes/Repo-Drive/agents}"
SUPERVISOR_URL="${AGENT_SUPERVISOR_URL:-http://127.0.0.1:4318}"
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

[[ -d "${AGENTS_DIR}/${agent}" ]] || {
  echo "Agent directory not found: ${AGENTS_DIR}/${agent}" >&2
  exit 1
}

request_id="restart-${agent}-$(date +%s)-$$"
body="$(
  jq -cn \
    --arg requestId "$request_id" \
    --arg agent "$agent" \
    --argjson force "$([[ "$FORCE_DISRUPTION" == "1" ]] && echo true || echo false)" \
    '{requestId: $requestId, operation: "restart", agent: $agent, force: $force}'
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
  jq -r '"Restarted: \(.agent) (\(.runtime)) via agent-supervisor"' "$response_file"
  exit 0
fi

reason="$(jq -r '.detail // .error // "agent-supervisor unavailable"' "$response_file" 2>/dev/null || cat "$response_file")"
echo "REFUSED: supervisor restart for $agent failed: $reason" >&2
[[ "$http_status" == "409" ]] && echo "Pass --force only with Jeremy's explicit override." >&2
exit 1
