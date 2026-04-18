#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${OPENCLAW_APP_DIR:-/home/machine/openclaw-orchestrator}"
REPO_URL="${OPENCLAW_REPO_URL:-https://github.com/MarcDasilva/HackPrincetonSpring2026.git}"
BRANCH="${OPENCLAW_BRANCH:-openclaw}"
ENV_FILE="${OPENCLAW_ENV_FILE:-/home/machine/openclaw.env}"

mkdir -p /home/machine

if [ ! -d "$APP_DIR/.git" ]; then
  rm -rf "$APP_DIR"
  git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
else
  git -C "$APP_DIR" fetch origin "$BRANCH"
  git -C "$APP_DIR" checkout "$BRANCH"
  git -C "$APP_DIR" pull --ff-only origin "$BRANCH"
fi

cd "$APP_DIR"
npm install

cat > /home/machine/start-gateway.sh <<'SH'
#!/usr/bin/env bash
set -euo pipefail
APP_DIR="${OPENCLAW_APP_DIR:-/home/machine/openclaw-orchestrator}"
ENV_FILE="${OPENCLAW_ENV_FILE:-/home/machine/openclaw.env}"
ROLE="${1:-foreman}"
if [ -f "$ENV_FILE" ]; then
  set -a
  . "$ENV_FILE"
  set +a
fi
cd "$APP_DIR"
mkdir -p /home/machine/logs
case "$ROLE" in
  foreman) CMD="npm run foreman" ;;
  worker-miner) CMD="npm run worker:miner" ;;
  worker-builder) CMD="npm run worker:builder" ;;
  worker-forager) CMD="npm run worker:forager" ;;
  *) echo "Unknown role: $ROLE" >&2; exit 1 ;;
esac
setsid bash -lc "$CMD" >"/home/machine/logs/${ROLE}.log" 2>&1 < /dev/null &
echo $! >"/home/machine/${ROLE}.pid"
echo "Started $ROLE with pid $(cat /home/machine/${ROLE}.pid)"
SH

chmod +x /home/machine/start-gateway.sh
echo "Bootstrap complete in $APP_DIR. Put secrets in $ENV_FILE, then run /home/machine/start-gateway.sh foreman|worker-miner|worker-builder|worker-forager"
