#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
. "$SCRIPT_DIR/common.sh"

render_worker_command() {
  local worker="$1"
  local template="${OPENCLAW_WORKER_COMMAND_TEMPLATE:-WORKER_ID={{worker}} node src/services/run-worker.js}"
  echo "${template//\{\{worker\}\}/$worker}"
}

main() {
  ensure_dirs
  load_app_env
  activate_runtime

  if [[ "${OPENCLAW_ENABLE_GATEWAYS:-0}" == "1" ]]; then
    "$SCRIPT_DIR/start-gateways.sh"
  fi

  if [[ -d "$OPENCLAW_ORCHESTRATOR_PATH" && -f "$OPENCLAW_ORCHESTRATOR_PATH/src/services/run-foreman.js" ]]; then
    if [[ -f "$OPENCLAW_ORCHESTRATOR_ENV_FILE" ]]; then
      set -a
      . "$OPENCLAW_ORCHESTRATOR_ENV_FILE"
      set +a
    fi

    start_once \
      "openclaw-foreman" \
      "$OPENCLAW_ORCHESTRATOR_PATH" \
      "$LOG_DIR/openclaw-foreman-app.log" \
      "${OPENCLAW_FOREMAN_COMMAND:-node src/services/run-foreman.js}"

    local worker
    for worker in $OPENCLAW_WORKER_IDS; do
      start_once \
        "openclaw-$worker" \
        "$OPENCLAW_ORCHESTRATOR_PATH" \
        "$LOG_DIR/openclaw-$worker-app.log" \
        "$(render_worker_command "$worker")"
    done
  else
    echo "Skipping OpenClaw app start: $OPENCLAW_ORCHESTRATOR_PATH is missing or incomplete."
  fi

  if [[ -n "${PHOTON_PROJECT_ID:-}" && -n "${PHOTON_PROJECT_SECRET:-}" ]]; then
    start_once \
      "photon-index" \
      "$APP_HOME" \
      "$LOG_DIR/photon-index.log" \
      "${PHOTON_COMMAND:-npm run photon}"
  else
    echo "Skipping Photon start: PHOTON_PROJECT_ID / PHOTON_PROJECT_SECRET are not set."
  fi

  "$SCRIPT_DIR/status.sh"
}

main "$@"
