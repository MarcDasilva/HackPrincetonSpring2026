#!/usr/bin/env bash
set -euo pipefail
ENV_FILE="${OPENCLAW_ENV_FILE:-/home/machine/openclaw.env}"
if [ -f "$ENV_FILE" ]; then
  set -a
  . "$ENV_FILE"
  set +a
fi
APP_DIR="${OPENCLAW_APP_DIR:-/home/machine/openclaw-orchestrator}"
NODE_DIR="${OPENCLAW_NODE_DIR:-/opt/openclaw-node}"
ROLE="${1:-foreman}"
export PATH="$APP_DIR/.venv/bin:$NODE_DIR/bin:$PATH"
export VOYAGER_PATH="${VOYAGER_PATH:-$APP_DIR}"
mkdir -p /home/machine/logs
case "$ROLE" in
  foreman) UNIT="openclaw-foreman.service" ;;
  worker-miner) UNIT="openclaw-worker-miner.service" ;;
  worker-builder) UNIT="openclaw-worker-builder.service" ;;
  worker-forager) UNIT="openclaw-worker-forager.service" ;;
  photon) UNIT="voyager-photon.service" ;;
  openclaw-gateways) exec /home/machine/start-openclaw-gateways.sh ;;
  voyager|multi-agent)
    echo "Role $ROLE is not managed by systemd on this host" >&2
    exit 1
    ;;
  *) echo "Unknown role: $ROLE" >&2; exit 1 ;;
esac

systemctl restart "$UNIT"
PID="$(systemctl show -p MainPID --value "$UNIT")"
if [ "$PID" != "0" ]; then
  echo "$PID" >"/home/machine/${ROLE}.pid"
fi

systemctl --no-pager --full status "$UNIT" | sed -n '1,12p'
echo "Started $ROLE via $UNIT${PID:+ with pid $PID}"
