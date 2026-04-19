#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${OPENCLAW_APP_DIR:-/home/machine/openclaw-orchestrator}"
REPO_URL="${OPENCLAW_REPO_URL:-https://github.com/MarcDasilva/HackPrincetonSpring2026.git}"
BRANCH="${OPENCLAW_BRANCH:-openclaw}"
ENV_FILE="${OPENCLAW_ENV_FILE:-/home/machine/openclaw.env}"
NODE_DIR="${OPENCLAW_NODE_DIR:-/home/machine/openclaw-node}"

TEMP_DIR="${OPENCLAW_TMP_DIR:-/tmp}"
if ! mkdir -p "$TEMP_DIR" 2>/dev/null || ! touch "$TEMP_DIR/.openclaw-write-test" 2>/dev/null; then
  TEMP_DIR="/home/machine"
fi
rm -f "$TEMP_DIR/.openclaw-write-test" 2>/dev/null || true

mkdir -p /home/machine
mkdir -p /home/machine/logs

install_system_packages() {
  if command -v git >/dev/null 2>&1 && command -v curl >/dev/null 2>&1 && command -v python3 >/dev/null 2>&1; then
    return
  fi
  if ! command -v apt-get >/dev/null 2>&1 || [ ! -w /var/lib/apt/lists ]; then
    return
  fi
  if command -v sudo >/dev/null 2>&1; then
    sudo apt-get update
    sudo apt-get install -y ca-certificates curl git python3 python3-pip
  else
    apt-get update
    apt-get install -y ca-certificates curl git python3 python3-pip
  fi
}

install_node_home() {
  if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
    return
  fi

  local arch
  case "$(uname -m)" in
    x86_64|amd64) arch="x64" ;;
    aarch64|arm64) arch="arm64" ;;
    *) echo "Unsupported Node architecture: $(uname -m)" >&2; exit 1 ;;
  esac

  local node_base="${OPENCLAW_NODE_BASE_URL:-https://nodejs.org/dist/latest-v22.x}"
  local listing
  local tarball
  if command -v wget >/dev/null 2>&1; then
    listing="$(wget -q -O - "$node_base/")"
  else
    listing="$(curl -fsSL "$node_base/")"
  fi
  tarball="$(printf "%s" "$listing" | sed -n "s|.*href=\"[^\"]*/\\(node-v[^\"]*-linux-${arch}.tar.gz\\)\".*|\\1|p" | sed -n "1p")"
  if [ -z "$tarball" ]; then
    echo "Could not find Node tarball for linux-${arch} at $node_base" >&2
    exit 1
  fi

  echo "Installing Node into $NODE_DIR"
  rm -rf "$NODE_DIR"
  mkdir -p "$NODE_DIR"
  local archive="$TEMP_DIR/openclaw-node.tar.gz"
  if command -v wget >/dev/null 2>&1; then
    wget -q -O "$archive" "$node_base/$tarball"
  else
    curl -fsSL "$node_base/$tarball" -o "$archive"
  fi
  tar -xzf "$archive" --strip-components=1 -C "$NODE_DIR"
  rm -f "$archive"
}

install_system_packages
for required in git curl python3; do
  if ! command -v "$required" >/dev/null 2>&1; then
    echo "Missing required command after bootstrap setup: $required" >&2
    exit 1
  fi
done

if [ ! -d "$APP_DIR/.git" ]; then
  rm -rf "$APP_DIR"
  echo "Cloning $REPO_URL branch $BRANCH into $APP_DIR"
  git -c core.fsync=none clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
else
  echo "Updating $APP_DIR branch $BRANCH"
  git -c core.fsync=none -C "$APP_DIR" fetch origin "$BRANCH"
  git -C "$APP_DIR" checkout "$BRANCH"
  git -c core.fsync=none -C "$APP_DIR" pull --ff-only origin "$BRANCH"
fi

install_node_home
export PATH="$NODE_DIR/bin:$PATH"

for required in node npm; do
  if ! command -v "$required" >/dev/null 2>&1; then
    echo "Missing required command after bootstrap setup: $required" >&2
    exit 1
  fi
done

cd "$APP_DIR"
echo "Installing npm dependencies"
npm install

cat > /home/machine/start-openclaw-gateways.sh <<'SH'
#!/usr/bin/env bash
set -euo pipefail
ENV_FILE="${OPENCLAW_ENV_FILE:-/home/machine/openclaw.env}"
if [ -f "$ENV_FILE" ]; then
  set -a
  . "$ENV_FILE"
  set +a
fi

mkdir -p /home/machine/logs
pkill -f "openclaw --profile foreman gateway" 2>/dev/null || true
pkill -f "openclaw --profile worker-miner gateway" 2>/dev/null || true
pkill -f "openclaw --profile worker-builder gateway" 2>/dev/null || true
pkill -f "openclaw --profile worker-forager gateway" 2>/dev/null || true
sleep 1

start_gateway() {
  local profile="$1"
  local url_var="$2"
  local token_var="$3"
  local url="${!url_var:-}"
  local token="${!token_var:-}"
  if [ -z "$url" ] || [ -z "$token" ]; then
    echo "Skipping $profile because $url_var or $token_var is unset"
    return
  fi
  local port="${url##*:}"
  setsid openclaw --profile "$profile" gateway --port "$port" --bind loopback --auth token --token "$token" --force --verbose >"/home/machine/logs/openclaw-${profile}-gateway.log" 2>&1 < /dev/null &
  echo $! >"/home/machine/openclaw-${profile}.pid"
  echo "Started OpenClaw gateway $profile on port $port with pid $(cat /home/machine/openclaw-${profile}.pid)"
}

start_gateway foreman FOREMAN_OPENCLAW_URL FOREMAN_OPENCLAW_TOKEN
start_gateway worker-miner WORKER_MINER_OPENCLAW_URL WORKER_MINER_OPENCLAW_TOKEN
start_gateway worker-builder WORKER_BUILDER_OPENCLAW_URL WORKER_BUILDER_OPENCLAW_TOKEN
start_gateway worker-forager WORKER_FORAGER_OPENCLAW_URL WORKER_FORAGER_OPENCLAW_TOKEN
SH

chmod +x /home/machine/start-openclaw-gateways.sh

cat > /home/machine/start-gateway.sh <<'SH'
#!/usr/bin/env bash
set -euo pipefail
ENV_FILE="${OPENCLAW_ENV_FILE:-/home/machine/openclaw.env}"
if [ -f "$ENV_FILE" ]; then
  set -a
  . "$ENV_FILE"
  set +a
fi
APP_DIR="${OPENCLAW_APP_DIR:-/home/machine/openclaw-orchestrator}"
NODE_DIR="${OPENCLAW_NODE_DIR:-/home/machine/openclaw-node}"
ROLE="${1:-foreman}"
export PATH="$APP_DIR/.venv/bin:$NODE_DIR/bin:$PATH"
export VOYAGER_PATH="${VOYAGER_PATH:-$APP_DIR}"
cd "$APP_DIR"
mkdir -p /home/machine/logs
case "$ROLE" in
  foreman) CMD="npm run foreman" ;;
  worker-miner) CMD="npm run worker:miner" ;;
  worker-builder) CMD="npm run worker:builder" ;;
  worker-forager) CMD="npm run worker:forager" ;;
  photon) CMD="npm run photon" ;;
  voyager) CMD="npm run voyager" ;;
  multi-agent) CMD="npm run multi-agent" ;;
  openclaw-gateways) CMD="/home/machine/start-openclaw-gateways.sh" ;;
  *) echo "Unknown role: $ROLE" >&2; exit 1 ;;
esac
setsid bash -lc "$CMD" >"/home/machine/logs/${ROLE}.log" 2>&1 < /dev/null &
echo $! >"/home/machine/${ROLE}.pid"
echo "Started $ROLE with pid $(cat /home/machine/${ROLE}.pid)"
SH

chmod +x /home/machine/start-gateway.sh
echo "Bootstrap complete in $APP_DIR. Put secrets in $ENV_FILE, then run /home/machine/start-gateway.sh foreman|worker-miner|worker-builder|worker-forager|photon|voyager|multi-agent|openclaw-gateways"
