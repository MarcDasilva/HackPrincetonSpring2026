#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
. "$SCRIPT_DIR/common.sh"

install_system_packages() {
  if [[ "${DEDALUS_SKIP_APT:-0}" == "1" ]]; then
    echo "Skipping apt package installation because DEDALUS_SKIP_APT=1."
    return 0
  fi

  local needs_apt=0
  for binary in curl git python3 tar xz; do
    if ! command -v "$binary" >/dev/null 2>&1; then
      needs_apt=1
      break
    fi
  done

  if ! python3 -m venv --help >/dev/null 2>&1; then
    needs_apt=1
  fi

  if ! command -v make >/dev/null 2>&1; then
    needs_apt=1
  fi

  if [[ "$needs_apt" -eq 1 ]]; then
    run_as_root apt-get update
    run_as_root apt-get install -y \
      ca-certificates \
      curl \
      git \
      python3 \
      python3-pip \
      python3-venv \
      build-essential \
      pkg-config \
      xz-utils
  fi
}

install_local_node() {
  local platform arch target_dir archive url archive_ext
  platform="$(uname -s | tr '[:upper:]' '[:lower:]')"

  case "$(uname -m)" in
    x86_64|amd64)
      arch="x64"
      ;;
    aarch64|arm64)
      arch="arm64"
      ;;
    *)
      echo "Unsupported architecture: $(uname -m)" >&2
      exit 1
      ;;
  esac

  target_dir="$DEDALUS_HOME/.local/node-v$NODE_VERSION-$platform-$arch"
  archive_ext="tar.xz"
  if ! command -v xz >/dev/null 2>&1; then
    archive_ext="tar.gz"
  fi

  archive="$DEDALUS_HOME/.cache/node-v$NODE_VERSION-$platform-$arch.$archive_ext"
  url="https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-$platform-$arch.$archive_ext"

  if [[ ! -x "$target_dir/bin/node" ]]; then
    curl -fsSL "$url" -o "$archive"
    rm -rf "$target_dir"
    if [[ "$archive_ext" == "tar.xz" ]]; then
      tar -xJf "$archive" -C "$DEDALUS_HOME/.local"
    else
      tar -xzf "$archive" -C "$DEDALUS_HOME/.local"
    fi
  fi

  ln -sfn "$target_dir" "$LOCAL_NODE_DIR"
  export PATH="$LOCAL_NODE_DIR/bin:$PATH"
}

create_virtualenv_with_pyz() {
  local virtualenv_pyz
  virtualenv_pyz="$DEDALUS_HOME/.cache/virtualenv.pyz"
  curl -fsSL "https://bootstrap.pypa.io/virtualenv.pyz" -o "$virtualenv_pyz"
  python3 "$virtualenv_pyz" "$VENV_DIR"
}

install_python_env() {
  if [[ ! -x "$VENV_DIR/bin/python" || ! -f "$VENV_DIR/bin/activate" || ! -x "$VENV_DIR/bin/pip" ]]; then
    rm -rf "$VENV_DIR"
    python3 -m venv "$VENV_DIR" || true

    if [[ ! -f "$VENV_DIR/bin/activate" || ! -x "$VENV_DIR/bin/pip" ]]; then
      echo "python3 -m venv failed; falling back to virtualenv bootstrap."
      rm -rf "$VENV_DIR"
      create_virtualenv_with_pyz
    fi
  fi

  # shellcheck disable=SC1090
  . "$VENV_DIR/bin/activate"
  python -m pip install --upgrade pip wheel setuptools
}

install_repo_dependencies() {
  cd "$APP_HOME"
  npm install

  if [[ "${DEDALUS_MINIMAL_BOOTSTRAP:-1}" == "1" ]]; then
    echo "Minimal bootstrap enabled; skipping Voyager environment package builds."
    return 0
  fi

  (
    cd "$APP_HOME/voyager/env/mineflayer/mineflayer-collectblock"
    npm install
    npx tsc
  )

  (
    cd "$APP_HOME/voyager/env/mineflayer"
    npm install
  )

  python -m pip install -e "$APP_HOME"
}

install_orchestrator_dependencies() {
  if [[ -f "$OPENCLAW_ORCHESTRATOR_PATH/package.json" ]]; then
    (
      cd "$OPENCLAW_ORCHESTRATOR_PATH"
      npm install
    )
  fi
}

main() {
  ensure_dirs
  load_app_env
  install_system_packages
  install_local_node

  if [[ "${DEDALUS_MINIMAL_BOOTSTRAP:-1}" != "1" ]]; then
    install_python_env
  fi

  install_repo_dependencies

  if [[ "${VOYAGER_ORCHESTRATION_BACKEND:-local}" == "openclaw" ]]; then
    install_orchestrator_dependencies
  fi

  cat <<EOF
Bootstrap complete.
App home: $APP_HOME
Node: $LOCAL_NODE_DIR/bin/node
Virtualenv: $VENV_DIR
Photon tracking: $PHOTON_TRACKING_DIR

Because Dedalus rebuilds the root filesystem on wake, rerun this bootstrap after waking the machine before starting services again.
EOF
}

main "$@"
