#!/usr/bin/env bash
set -euo pipefail

cd /Volumes/Repo-Drive/src/mcc-tmux

exec npm run a2a-poller --workspace=@mcc-tmux/server
