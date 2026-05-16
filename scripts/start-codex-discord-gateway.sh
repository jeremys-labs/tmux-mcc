#!/usr/bin/env bash
# start-codex-discord-gateway.sh — run one shared Codex Discord bridge for multiple agents
#
# Usage:
#   ./scripts/start-codex-discord-gateway.sh zara marcus
#   ./scripts/start-codex-discord-gateway.sh zara

set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <agent-key> [agent-key...]" >&2
  exit 1
fi

MCC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENTS_DIR="${AGENTS_DIR:-/Volumes/Repo-Drive/agents}"
CONTENT_ROOT="${CONTENT_ROOT:-$HOME/.tmux-mcc}"
TMP_CONFIG="$(mktemp -t codex-discord-gateway)"

cleanup() {
  rm -f "$TMP_CONFIG"
}
trap cleanup EXIT

JSON='{"bindings":['
FIRST=1

for AGENT_KEY in "$@"; do
  AGENT_DIR="${AGENTS_DIR}/${AGENT_KEY}"
  DISCORD_STATE_DIR="${AGENT_DIR}/.claude/discord"
  ACCESS_PATH="${DISCORD_STATE_DIR}/access.json"
  ENV_PATH="${DISCORD_STATE_DIR}/.env"

  if [[ ! -f "$ACCESS_PATH" ]]; then
    echo "ERROR: missing access.json for ${AGENT_KEY} at ${ACCESS_PATH}" >&2
    exit 1
  fi

  if [[ ! -f "$ENV_PATH" ]]; then
    echo "ERROR: missing .env for ${AGENT_KEY} at ${ENV_PATH}" >&2
    exit 1
  fi

  TOKEN="$(sed -n 's/^DISCORD_BOT_TOKEN=//p' "$ENV_PATH" | head -n 1)"
  if [[ -z "$TOKEN" ]]; then
    echo "ERROR: DISCORD_BOT_TOKEN not found in ${ENV_PATH}" >&2
    exit 1
  fi

  TOKEN_ENV_VAR="DISCORD_BOT_TOKEN_$(echo "$AGENT_KEY" | tr '[:lower:]-' '[:upper:]_')"
  export "$TOKEN_ENV_VAR=$TOKEN"

  GROUP_JSON="$(python3 - <<PY
import json
from pathlib import Path
access = json.loads(Path("$ACCESS_PATH").read_text())
groups = []
for channel_id, cfg in (access.get("groups") or {}).items():
    sub = {"agentKey": "$AGENT_KEY", "channelId": channel_id}
    bot_ids = cfg.get("allowBotIds") if isinstance(cfg, dict) else None
    if bot_ids:
        sub["allowBotIds"] = bot_ids
    groups.append(sub)
print(json.dumps(groups))
PY
)"

  if [[ "$GROUP_JSON" == "[]" ]]; then
    echo "ERROR: no allowed Discord groups/channels found for ${AGENT_KEY} in ${ACCESS_PATH}" >&2
    exit 1
  fi

  if [[ $FIRST -eq 0 ]]; then
    JSON+=','
  fi
  FIRST=0
  JSON+="{\"name\":\"${AGENT_KEY}\",\"tokenEnvVar\":\"${TOKEN_ENV_VAR}\",\"subscriptions\":${GROUP_JSON}}"
done

JSON+=']}'
printf '%s\n' "$JSON" > "$TMP_CONFIG"

export DISCORD_BRIDGE_CONFIG="$TMP_CONFIG"
export CONTENT_ROOT

exec npm run bridge:codex-discord --workspace=@mcc-tmux/server --prefix "$MCC_DIR"
