#!/usr/bin/env bash
set -euo pipefail

# Snapshot of /home/machine/openclaw-gateways/start-openclaw-gateways.sh.
# Live tokens were redacted before this copy was committed.
pkill -f "openclaw --profile foreman gateway" 2>/dev/null || true
pkill -f "openclaw --profile worker-miner gateway" 2>/dev/null || true
pkill -f "openclaw --profile worker-builder gateway" 2>/dev/null || true
sleep 1

setsid openclaw --profile foreman gateway --port 8100 --bind loopback --auth token --token "REDACTED_FOREMAN_TOKEN" --force --verbose > /home/machine/logs/openclaw-foreman-gateway.log 2>&1 < /dev/null &
setsid openclaw --profile worker-miner gateway --port 8111 --bind loopback --auth token --token "REDACTED_WORKER_MINER_TOKEN" --force --verbose > /home/machine/logs/openclaw-worker-miner-gateway.log 2>&1 < /dev/null &
setsid openclaw --profile worker-builder gateway --port 8112 --bind loopback --auth token --token "REDACTED_WORKER_BUILDER_TOKEN" --force --verbose > /home/machine/logs/openclaw-worker-builder-gateway.log 2>&1 < /dev/null &
