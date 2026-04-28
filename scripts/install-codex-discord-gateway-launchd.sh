#!/usr/bin/env bash

set -euo pipefail

MCC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENTS=("$@")

if [[ ${#AGENTS[@]} -eq 0 ]]; then
  AGENTS=(zara marcus eli)
fi

LABEL="${LABEL:-com.jeremylahners.codex-discord-gateway}"
LEGACY_LABEL="${LEGACY_LABEL:-com.openclaw.codex-discord-gateway}"
HOME_DIR="${HOME}"
LAUNCH_AGENTS_DIR="${HOME_DIR}/Library/LaunchAgents"
PLIST_PATH="${LAUNCH_AGENTS_DIR}/${LABEL}.plist"
LEGACY_PLIST_PATH="${LAUNCH_AGENTS_DIR}/${LEGACY_LABEL}.plist"
LOG_DIR="${MCC_DIR}/logs"
STDOUT_PATH="${LOG_DIR}/codex-discord-gateway.log"
STDERR_PATH="${LOG_DIR}/codex-discord-gateway.err.log"
UID_VALUE="$(id -u)"

mkdir -p "$LAUNCH_AGENTS_DIR" "$LOG_DIR"

PROGRAM_ARGS_XML=""
for agent in "${AGENTS[@]}"; do
  PROGRAM_ARGS_XML+="        <string>${agent}</string>
"
done

cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>

    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>${MCC_DIR}/scripts/start-codex-discord-gateway.sh</string>
${PROGRAM_ARGS_XML}    </array>

    <key>WorkingDirectory</key>
    <string>${MCC_DIR}</string>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>

    <key>ThrottleInterval</key>
    <integer>10</integer>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
        <key>HOME</key>
        <string>${HOME_DIR}</string>
    </dict>

    <key>StandardOutPath</key>
    <string>${STDOUT_PATH}</string>

    <key>StandardErrorPath</key>
    <string>${STDERR_PATH}</string>
</dict>
</plist>
EOF

launchctl bootout "gui/${UID_VALUE}" "${PLIST_PATH}" >/dev/null 2>&1 || true
if [[ "${LEGACY_LABEL}" != "${LABEL}" ]]; then
  launchctl bootout "gui/${UID_VALUE}" "${LEGACY_PLIST_PATH}" >/dev/null 2>&1 || true
  rm -f "${LEGACY_PLIST_PATH}"
fi
launchctl bootstrap "gui/${UID_VALUE}" "${PLIST_PATH}"
launchctl enable "gui/${UID_VALUE}/${LABEL}"
launchctl kickstart -k "gui/${UID_VALUE}/${LABEL}"

echo "Installed ${LABEL}"
echo "Plist: ${PLIST_PATH}"
echo "Agents: ${AGENTS[*]}"
echo "Stdout: ${STDOUT_PATH}"
echo "Stderr: ${STDERR_PATH}"
