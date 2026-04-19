#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
. "$SCRIPT_DIR/common.sh"

print_process_status() {
  local name="$1"
  local pid_file="$RUN_DIR/$name.pid"

  if [[ -f "$pid_file" ]]; then
    local pid
    pid="$(cat "$pid_file")"
    if kill -0 "$pid" 2>/dev/null; then
      echo "$name: running (pid $pid)"
      return
    fi
    echo "$name: stale pid file ($pid)"
    return
  fi

  echo "$name: stopped"
}

main() {
  ensure_dirs
  load_app_env
  local backend
  backend="${VOYAGER_ORCHESTRATION_BACKEND:-local}"

  print_process_status "photon-index"
  echo "orchestration-backend: $backend"

  if [[ "$backend" == "openclaw" ]]; then
    print_process_status "openclaw-foreman"
    local worker
    for worker in $OPENCLAW_WORKER_IDS; do
      print_process_status "openclaw-$worker"
    done
  fi

  echo
  echo "Logs: $LOG_DIR"
  echo "Photon tracking: $PHOTON_TRACKING_DIR"
  echo "OpenClaw orchestrator: $OPENCLAW_ORCHESTRATOR_PATH"

  if command -v ss >/dev/null 2>&1; then
    echo
    echo "Listening ports:"
    ss -ltnp | grep -E ':(8100|8111|8112|3000|3001|3002)\b' || true
  fi
}

main "$@"
