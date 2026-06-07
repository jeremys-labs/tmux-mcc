#!/usr/bin/env bash

protect_working_check() {
  local agent="$1"
  local force="${2:-0}"
  local supervisor_url="${AGENT_SUPERVISOR_URL:-http://127.0.0.1:4318}"
  local response_file
  response_file="$(mktemp)"
  local query="agent=${agent}"
  [[ "$force" == "1" ]] && query="${query}&force=true"

  local http_status
  http_status="$(
    curl --silent --show-error --output "$response_file" --write-out '%{http_code}' \
      "${supervisor_url}/v1/disruption-check?${query}" || true
  )"

  if [[ "$http_status" == "200" ]]; then
    local reason
    reason="$(jq -r '.reason' "$response_file" 2>/dev/null || cat "$response_file")"
    echo "Disruption preflight: $agent allowed ($reason)"
    rm -f "$response_file"
    return 0
  fi

  local reason
  reason="$(jq -r '.reason // .error // \"agent-supervisor unavailable\"' "$response_file" 2>/dev/null || cat "$response_file")"
  rm -f "$response_file"
  echo "REFUSED: disruption preflight for $agent failed: $reason" >&2
  [[ "$http_status" == "409" ]] && echo "Pass --force only with Jeremy's explicit override." >&2
  return 1
}
