#!/usr/bin/env bash
# A2A canary — verifies the Tom Egibson gateway responds to a real task end-to-end.
#
# 1. Confirms the public agent card returns 10 skills.
# 2. Sends a message/send to the code-review skill.
# 3. Polls tasks/get until the task completes or 5 minutes elapse.
# 4. Prints the result + fingerprint of the bearer used (never the value).
#
# Bearer is read from ~/.tmux-mcc/secrets/a2a-tomegibson.token (mode 0600). Treat
# as a credential parked from Discord chat 1507398270501126256 message
# 1507816358816251974 (Hank posted plaintext — Isla flagged it as already
# compromised from a rotation-clock perspective).

set -euo pipefail

BASE_URL="https://agents.tomegibson.com"
TOKEN_FILE="${HOME}/.tmux-mcc/secrets/a2a-tomegibson.token"
SKILL_ID="code-review"
POLL_INTERVAL=5
MAX_WAIT_SECONDS=300

if [[ ! -r "${TOKEN_FILE}" ]]; then
  echo "fatal: token file not readable: ${TOKEN_FILE}" >&2
  exit 1
fi

BEARER="$(<"${TOKEN_FILE}")"
FP="$(printf '%s' "${BEARER}" | shasum -a 256 | awk '{print substr($1, 1, 12)}')"

echo "== A2A canary =="
echo "base_url:          ${BASE_URL}"
echo "skill:             ${SKILL_ID}"
echo "bearer fingerprint:sha256:${FP} (first 12 hex)"
echo "poll cadence:      ${POLL_INTERVAL}s, max ${MAX_WAIT_SECONDS}s total"
echo

echo "-- step 1: GET /.well-known/agent-card.json --"
CARD_HTTP_BODY="$(curl -sf --max-time 15 "${BASE_URL}/.well-known/agent-card.json")"
SKILL_COUNT="$(printf '%s' "${CARD_HTTP_BODY}" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(len(d.get("skills", [])))')"
echo "agent card returned ${SKILL_COUNT} skills"
if [[ "${SKILL_COUNT}" != "10" ]]; then
  echo "WARN: expected 10 skills per Isla's brief, got ${SKILL_COUNT}" >&2
fi
echo

echo "-- step 2: POST message/send --"
SEND_PAYLOAD=$(cat <<'JSON'
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "message/send",
  "params": {
    "message": {
      "parts": [
        { "text": "A2A canary from Jeremy's fleet (sent by eli). Please reply with the single word ACK and exit immediately; we are validating end-to-end transport, not requesting an actual code review." }
      ],
      "metadata": {
        "skillId": "code-review",
        "requesterId": "jeremys-fleet:eli"
      }
    }
  }
}
JSON
)

SEND_RESPONSE="$(curl -sf --max-time 30 \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${BEARER}" \
  -X POST "${BASE_URL}/" \
  -d "${SEND_PAYLOAD}")"

echo "send response:"
printf '%s\n' "${SEND_RESPONSE}" | python3 -m json.tool
TASK_ID="$(printf '%s' "${SEND_RESPONSE}" | python3 -c 'import json,sys; r=json.load(sys.stdin); res=r.get("result", {}); print(res.get("id") or res.get("taskId") or "")')"
if [[ -z "${TASK_ID}" ]]; then
  echo "fatal: no task id in send response" >&2
  exit 2
fi
echo "task id: ${TASK_ID}"
echo

echo "-- step 3: poll tasks/get until terminal or ${MAX_WAIT_SECONDS}s --"
ELAPSED=0
while (( ELAPSED < MAX_WAIT_SECONDS )); do
  sleep "${POLL_INTERVAL}"
  ELAPSED=$(( ELAPSED + POLL_INTERVAL ))
  GET_PAYLOAD=$(printf '{"jsonrpc":"2.0","id":2,"method":"tasks/get","params":{"id":"%s"}}' "${TASK_ID}")
  GET_RESPONSE="$(curl -sf --max-time 30 \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${BEARER}" \
    -X POST "${BASE_URL}/" \
    -d "${GET_PAYLOAD}")"
  STATE="$(printf '%s' "${GET_RESPONSE}" | python3 -c '
import json, sys
try:
    r = json.load(sys.stdin)
    res = r.get("result", {}) or {}
    s = res.get("status", {}) or {}
    print(s.get("state") or res.get("state") or "unknown")
except Exception:
    print("parse_error")
')"
  echo "  t+${ELAPSED}s  state=${STATE}"
  case "${STATE}" in
    completed|succeeded|done|terminal)
      echo
      echo "-- terminal response --"
      printf '%s\n' "${GET_RESPONSE}" | python3 -m json.tool
      echo
      echo "RESULT: green (canary completed in ~${ELAPSED}s)"
      exit 0
      ;;
    failed|errored|canceled|cancelled|rejected)
      echo
      echo "-- terminal response --"
      printf '%s\n' "${GET_RESPONSE}" | python3 -m json.tool
      echo
      echo "RESULT: red (task ended in non-success terminal state: ${STATE})"
      exit 3
      ;;
  esac
done

echo
echo "RESULT: yellow (no terminal state inside ${MAX_WAIT_SECONDS}s window; treat as 'reachable but slow')"
exit 4
