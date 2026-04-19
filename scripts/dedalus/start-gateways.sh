#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
. "$SCRIPT_DIR/common.sh"

main() {
  ensure_dirs
  load_app_env
  activate_runtime

  if ! command -v openclaw >/dev/null 2>&1; then
    echo "openclaw CLI is not installed on this machine." >&2
    exit 1
  fi

  if [[ ! -f "$OPENCLAW_GATEWAY_ENV_FILE" ]]; then
    echo "Missing OpenClaw gateway env file: $OPENCLAW_GATEWAY_ENV_FILE" >&2
    exit 1
  fi

  set -a
  . "$OPENCLAW_GATEWAY_ENV_FILE"
  set +a

  pkill -f "openclaw --profile foreman gateway" 2>/dev/null || true
  pkill -f "openclaw --profile worker-miner gateway" 2>/dev/null || true
  pkill -f "openclaw --profile worker-builder gateway" 2>/dev/null || true
  sleep 1

  nohup openclaw --profile foreman gateway \
    --port "${FOREMAN_OPENCLAW_URL##*:}" \
    --bind loopback \
    --auth token \
    --token "$FOREMAN_OPENCLAW_TOKEN" \
    --force \
    --verbose >>"$LOG_DIR/openclaw-foreman-gateway.log" 2>&1 &

  nohup openclaw --profile worker-miner gateway \
    --port "${WORKER_MINER_OPENCLAW_URL##*:}" \
    --bind loopback \
    --auth token \
    --token "$WORKER_MINER_OPENCLAW_TOKEN" \
    --force \
    --verbose >>"$LOG_DIR/openclaw-worker-miner-gateway.log" 2>&1 &

  nohup openclaw --profile worker-builder gateway \
    --port "${WORKER_BUILDER_OPENCLAW_URL##*:}" \
    --bind loopback \
    --auth token \
    --token "$WORKER_BUILDER_OPENCLAW_TOKEN" \
    --force \
    --verbose >>"$LOG_DIR/openclaw-worker-builder-gateway.log" 2>&1 &

  echo "Started OpenClaw gateways"
}

main "$@"
