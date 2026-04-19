#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
. "$SCRIPT_DIR/common.sh"

main() {
  ensure_dirs
  load_app_env

  stop_once "photon-index"
  stop_once "openclaw-foreman"

  local worker
  for worker in $OPENCLAW_WORKER_IDS; do
    stop_once "openclaw-$worker"
  done

  pkill -f "openclaw --profile foreman gateway" 2>/dev/null || true
  pkill -f "openclaw --profile worker-miner gateway" 2>/dev/null || true
  pkill -f "openclaw --profile worker-builder gateway" 2>/dev/null || true
}

main "$@"
