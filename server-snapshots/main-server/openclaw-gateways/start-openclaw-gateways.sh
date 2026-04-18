#!/usr/bin/env bash
set -euo pipefail

# Snapshot of /home/machine/openclaw-gateways/start-openclaw-gateways.sh.
# Live tokens were redacted before this copy was committed.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

set -a
. "$SCRIPT_DIR/openclaw-gateway.env"
set +a

pkill -f "openclaw --profile foreman gateway" 2>/dev/null || true
pkill -f "openclaw --profile worker-miner gateway" 2>/dev/null || true
pkill -f "openclaw --profile worker-builder gateway" 2>/dev/null || true
sleep 1

setsid openclaw --profile foreman gateway --port "${FOREMAN_OPENCLAW_URL##*:}" --bind loopback --auth token --token "$FOREMAN_OPENCLAW_TOKEN" --force --verbose > /home/machine/logs/openclaw-foreman-gateway.log 2>&1 < /dev/null &
setsid openclaw --profile worker-miner gateway --port "${WORKER_MINER_OPENCLAW_URL##*:}" --bind loopback --auth token --token "$WORKER_MINER_OPENCLAW_TOKEN" --force --verbose > /home/machine/logs/openclaw-worker-miner-gateway.log 2>&1 < /dev/null &
setsid openclaw --profile worker-builder gateway --port "${WORKER_BUILDER_OPENCLAW_URL##*:}" --bind loopback --auth token --token "$WORKER_BUILDER_OPENCLAW_TOKEN" --force --verbose > /home/machine/logs/openclaw-worker-builder-gateway.log 2>&1 < /dev/null &
