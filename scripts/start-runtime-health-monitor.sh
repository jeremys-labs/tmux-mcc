#!/usr/bin/env bash
set -euo pipefail

cd /Volumes/Repo-Drive/src/mcc-tmux

# OPERATOR DESTINATION, not a subject. Every finding this monitor produces is ABOUT some
# agent; it must never be delivered into a channel belonging to one of its own subjects.
# On 2026-09-12 a `consumed_idle_no_reply` finding for a dead runtime was posted into that
# runtime's own channel -- correct detection, delivered to the one place that could not act
# on it. The detector was never broken; the destination was.
#
# isla is the roster owner and the agent who performs the un-park/relaunch action, so she
# is the destination that can ACT. Precedence, first live one wins (see
# agent_docs/procedures/exit-0-and-nothing-happened.md):
#   1. isla   2. Jeremy's DM   3. log honestly, leave the gap visible
#
# The code no longer TRUSTS this flag -- `planAlertDispatch` partitions out any finding
# whose subject is the destination, so a finding about isla cannot reach isla's channel
# regardless of what is written here. That guard landed in a2829ff and had to land FIRST:
# repointing before it would have relocated the 09-12 defect rather than fixed it.
exec npm run open-brain:runtime-health-monitor --workspace=@mcc-tmux/server -- \
  --agent isla \
  --chat-id 1493425484036309092
