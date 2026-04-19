#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
. "$SCRIPT_DIR/common.sh"

main() {
  ensure_dirs
  load_app_env
  activate_runtime

  local repo_url branch
  repo_url="${OPENCLAW_ORCHESTRATOR_REPO:-}"
  branch="${OPENCLAW_ORCHESTRATOR_BRANCH:-main}"

  if [[ -z "$repo_url" ]]; then
    echo "Set OPENCLAW_ORCHESTRATOR_REPO to clone the orchestrator." >&2
    exit 1
  fi

  if [[ -d "$OPENCLAW_ORCHESTRATOR_PATH/.git" ]]; then
    git -C "$OPENCLAW_ORCHESTRATOR_PATH" fetch --all --prune
    git -C "$OPENCLAW_ORCHESTRATOR_PATH" checkout "$branch"
    git -C "$OPENCLAW_ORCHESTRATOR_PATH" pull --ff-only origin "$branch"
  else
    rm -rf "$OPENCLAW_ORCHESTRATOR_PATH"
    git clone --branch "$branch" "$repo_url" "$OPENCLAW_ORCHESTRATOR_PATH"
  fi

  (
    cd "$OPENCLAW_ORCHESTRATOR_PATH"
    npm install
  )

  if [[ -f "$OPENCLAW_ORCHESTRATOR_PATH/.env.example" && ! -f "$OPENCLAW_ORCHESTRATOR_ENV_FILE" ]]; then
    echo "Create $OPENCLAW_ORCHESTRATOR_ENV_FILE before starting the stack." >&2
  fi

  echo "OpenClaw orchestrator ready at $OPENCLAW_ORCHESTRATOR_PATH"
}

main "$@"
