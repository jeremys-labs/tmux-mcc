#!/usr/bin/env bash
set -euo pipefail

cd /Volumes/Repo-Drive/src/mcc-tmux

exec npm run open-brain:runtime-health-monitor --workspace=@mcc-tmux/server -- \
  --agent eli \
  --chat-id 1491979880747765810
