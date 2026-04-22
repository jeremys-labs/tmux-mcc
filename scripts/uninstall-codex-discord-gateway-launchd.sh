#!/usr/bin/env bash

set -euo pipefail

LABEL="${LABEL:-com.jeremylahners.codex-discord-gateway}"
LEGACY_LABEL="${LEGACY_LABEL:-com.openclaw.codex-discord-gateway}"
PLIST_PATH="${HOME}/Library/LaunchAgents/${LABEL}.plist"
LEGACY_PLIST_PATH="${HOME}/Library/LaunchAgents/${LEGACY_LABEL}.plist"
UID_VALUE="$(id -u)"

launchctl bootout "gui/${UID_VALUE}" "${PLIST_PATH}" >/dev/null 2>&1 || true
rm -f "${PLIST_PATH}"
if [[ "${LEGACY_LABEL}" != "${LABEL}" ]]; then
  launchctl bootout "gui/${UID_VALUE}" "${LEGACY_PLIST_PATH}" >/dev/null 2>&1 || true
  rm -f "${LEGACY_PLIST_PATH}"
fi

echo "Removed ${LABEL}"
echo "Plist: ${PLIST_PATH}"
