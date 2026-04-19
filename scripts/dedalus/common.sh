#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${APP_HOME:-}" ]]; then
  APP_HOME="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fi

default_dedalus_home="/home/machine"
if [[ ! -d "/home/machine" && ! -w "/home" ]]; then
  default_dedalus_home="$HOME/.dedalus-machine"
fi

DEDALUS_HOME="${DEDALUS_HOME:-$default_dedalus_home}"
LOG_DIR="${LOG_DIR:-$DEDALUS_HOME/logs}"
RUN_DIR="${RUN_DIR:-$DEDALUS_HOME/run/voyager-dedalus}"
PHOTON_TRACKING_DIR="${PHOTON_TRACKING_DIR:-$DEDALUS_HOME/photon-progress}"
LOCAL_NODE_DIR="${LOCAL_NODE_DIR:-$DEDALUS_HOME/.local/node}"
VENV_DIR="${VENV_DIR:-$DEDALUS_HOME/.venvs/voyager}"
NODE_VERSION="${NODE_VERSION:-20.19.0}"
OPENCLAW_ORCHESTRATOR_PATH="${OPENCLAW_ORCHESTRATOR_PATH:-$DEDALUS_HOME/openclaw-orchestrator}"
OPENCLAW_ORCHESTRATOR_ENV_FILE="${OPENCLAW_ORCHESTRATOR_ENV_FILE:-$OPENCLAW_ORCHESTRATOR_PATH/.env}"
OPENCLAW_WORKER_IDS="${OPENCLAW_WORKER_IDS:-worker-miner worker-builder}"
OPENCLAW_GATEWAY_ENV_FILE="${OPENCLAW_GATEWAY_ENV_FILE:-$DEDALUS_HOME/openclaw-gateways/openclaw-gateway.env}"
VOYAGER_ORCHESTRATION_BACKEND="${VOYAGER_ORCHESTRATION_BACKEND:-local}"

export APP_HOME DEDALUS_HOME LOG_DIR RUN_DIR PHOTON_TRACKING_DIR LOCAL_NODE_DIR VENV_DIR
export NODE_VERSION OPENCLAW_ORCHESTRATOR_PATH OPENCLAW_ORCHESTRATOR_ENV_FILE
export OPENCLAW_WORKER_IDS OPENCLAW_GATEWAY_ENV_FILE VOYAGER_ORCHESTRATION_BACKEND

ensure_dirs() {
  mkdir -p \
    "$LOG_DIR" \
    "$RUN_DIR" \
    "$PHOTON_TRACKING_DIR/proposals" \
    "$PHOTON_TRACKING_DIR/runs" \
    "$DEDALUS_HOME/.cache" \
    "$DEDALUS_HOME/.local" \
    "$DEDALUS_HOME/.venvs"
}

load_app_env() {
  if [[ -f "$APP_HOME/.env.dedalus" ]]; then
    set -a
    . "$APP_HOME/.env.dedalus"
    set +a
  elif [[ -f "$APP_HOME/.env" ]]; then
    set -a
    . "$APP_HOME/.env"
    set +a
  fi

  export VOYAGER_PATH="${VOYAGER_PATH:-$APP_HOME}"
  export PHOTON_TRACKING_DIR="${PHOTON_TRACKING_DIR:-$DEDALUS_HOME/photon-progress}"
  export OPENCLAW_ORCHESTRATOR_PATH="${OPENCLAW_ORCHESTRATOR_PATH:-$DEDALUS_HOME/openclaw-orchestrator}"
  export OPENCLAW_ORCHESTRATOR_ENV_FILE="${OPENCLAW_ORCHESTRATOR_ENV_FILE:-$OPENCLAW_ORCHESTRATOR_PATH/.env}"
  export OPENCLAW_GATEWAY_ENV_FILE="${OPENCLAW_GATEWAY_ENV_FILE:-$DEDALUS_HOME/openclaw-gateways/openclaw-gateway.env}"
  export VOYAGER_ORCHESTRATION_BACKEND="${VOYAGER_ORCHESTRATION_BACKEND:-local}"
}

activate_runtime() {
  export PATH="$LOCAL_NODE_DIR/bin:$PATH"
  if [[ -d "$VENV_DIR" ]]; then
    # shellcheck disable=SC1090
    . "$VENV_DIR/bin/activate"
  fi
}

run_as_root() {
  if [[ "$(id -u)" -eq 0 ]]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  else
    echo "This command needs root privileges: $*" >&2
    return 1
  fi
}

start_once() {
  local name="$1"
  local cwd="$2"
  local log_file="$3"
  local command="$4"
  local pid_file="$RUN_DIR/$name.pid"

  if [[ -f "$pid_file" ]]; then
    local existing_pid
    existing_pid="$(cat "$pid_file")"
    if kill -0 "$existing_pid" 2>/dev/null; then
      echo "$name already running (pid $existing_pid)"
      return 0
    fi
    rm -f "$pid_file"
  fi

  (
    cd "$cwd"
    nohup bash -lc "$command" >>"$log_file" 2>&1 &
    echo $! >"$pid_file"
  )

  echo "Started $name (pid $(cat "$pid_file"))"
}

stop_once() {
  local name="$1"
  local pid_file="$RUN_DIR/$name.pid"

  if [[ ! -f "$pid_file" ]]; then
    echo "$name not running"
    return 0
  fi

  local pid
  pid="$(cat "$pid_file")"
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid"
    echo "Stopped $name (pid $pid)"
  else
    echo "$name pid file was stale ($pid)"
  fi
  rm -f "$pid_file"
}
