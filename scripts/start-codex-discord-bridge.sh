#!/usr/bin/env bash
# start-codex-discord-bridge.sh — single-agent wrapper around the multi-agent gateway launcher
#
# Usage:
#   ./scripts/start-codex-discord-bridge.sh zara

set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <agent-key>" >&2
  exit 1
fi

exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/start-codex-discord-gateway.sh" "$1"
