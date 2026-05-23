#!/usr/bin/env bash
# A2A canary — verifies the full outbound loop: a2a-mail send → pending.jsonl → poller → isla mailbox.
#
# Prerequisites:
#   - Eli's a2a-mail CLI installed and on PATH
#   - com.jeremylahners.mcc-a2a-poller launchd service running (or poller in foreground)
#   - ~/.tmux-mcc/secrets/a2a-tomegibson.token present
#
# Usage:
#   ./scripts/a2a-canary.sh [--timeout 120]

set -euo pipefail

AGENT_MAIL_DIR="${AGENT_MAIL_DIR:-/Volumes/Repo-Drive/agents/SHARED/agent-mail}"
PENDING_PATH="${HOME}/.tmux-mcc/a2a/pending.jsonl"
FROM_AGENT="isla"
SKILL_ID="code-review"
PEER="tomegibson"
MAX_WAIT="${1:-120}"
POLL_INTERVAL=5

echo "== A2A canary (full loop) =="
echo "from:    ${FROM_AGENT}"
echo "peer:    ${PEER}"
echo "skill:   ${SKILL_ID}"
echo "timeout: ${MAX_WAIT}s"
echo

echo "-- step 1: send via a2a-mail --"
SEND_OUT="$(a2a-mail send \
  --from "${FROM_AGENT}" \
  --peer "${PEER}" \
  --skill "${SKILL_ID}" \
  --message "A2A canary: please reply with the single word ACK. This is a transport verification, not a real review request." \
  --project private)"
echo "${SEND_OUT}"

TASK_ID="$(printf '%s' "${SEND_OUT}" | grep -oE 'task[_a-zA-Z0-9]+' | head -1 || true)"
if [[ -z "${TASK_ID}" ]]; then
  echo "WARN: could not extract task ID from send output — will watch mailbox only"
fi

echo
echo "-- step 2: confirm pending.jsonl row --"
ELAPSED=0
FOUND_PENDING=false
while (( ELAPSED < 15 )); do
  if [[ -f "${PENDING_PATH}" ]] && grep -q "${TASK_ID:-canary}" "${PENDING_PATH}" 2>/dev/null; then
    echo "pending.jsonl row confirmed (t+${ELAPSED}s)"
    FOUND_PENDING=true
    break
  fi
  sleep "${POLL_INTERVAL}"
  ELAPSED=$(( ELAPSED + POLL_INTERVAL ))
done

if [[ "${FOUND_PENDING}" == "false" ]]; then
  echo "WARN: task not found in pending.jsonl after 15s — poller may have already consumed it"
fi

echo
echo "-- step 3: poll isla's mailbox for a2a result --"
ELAPSED=0
while (( ELAPSED < MAX_WAIT )); do
  sleep "${POLL_INTERVAL}"
  ELAPSED=$(( ELAPSED + POLL_INTERVAL ))

  INBOX_JSON="$(AGENT_MAIL_DIR="${AGENT_MAIL_DIR}" agent-mail inbox --agent "${FROM_AGENT}" --status new --json 2>/dev/null || echo '[]')"
  A2A_MSG="$(printf '%s' "${INBOX_JSON}" | python3 -c "
import json, sys
msgs = json.load(sys.stdin)
for m in msgs:
    if 'a2a:${PEER}' in m.get('fromAgent','') or '[A2A]' in m.get('subject',''):
        print(json.dumps(m, indent=2))
        break
" 2>/dev/null || true)"

  if [[ -n "${A2A_MSG}" ]]; then
    echo
    echo "-- result received (t+${ELAPSED}s) --"
    printf '%s\n' "${A2A_MSG}"
    echo
    echo "RESULT: green (full A2A loop confirmed in ~${ELAPSED}s)"
    exit 0
  fi

  echo "  t+${ELAPSED}s  waiting for a2a result in ${FROM_AGENT} mailbox..."
done

echo
echo "RESULT: yellow (no a2a result in mailbox after ${MAX_WAIT}s)"
echo "Check: a2a-poller log at /Volumes/Repo-Drive/src/mcc-tmux/logs/a2a-poller.log"
echo "Check: pending.jsonl at ${PENDING_PATH}"
exit 4
