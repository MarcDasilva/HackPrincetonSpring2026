#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
. "$SCRIPT_DIR/common.sh"

json_get() {
  local path="$1"
  local json_input
  json_input="$(cat)"
  JSON_INPUT="$json_input" python3 - "$path" <<'PY'
import json
import os
import sys

path = sys.argv[1].split(".")
value = json.loads(os.environ["JSON_INPUT"])
for part in path:
    value = value[part]
print(value)
PY
}

infer_repo_url() {
  local repo_url
  repo_url="${DEDALUS_APP_REPO:-$(git -C "$APP_HOME" remote get-url origin)}"
  case "$repo_url" in
    git@github.com:*)
      repo_url="https://github.com/${repo_url#git@github.com:}"
      ;;
  esac
  echo "$repo_url"
}

infer_branch() {
  local branch
  branch="${DEDALUS_APP_BRANCH:-$(git -C "$APP_HOME" rev-parse --abbrev-ref HEAD)}"
  if ! git -C "$APP_HOME" ls-remote --exit-code --heads origin "$branch" >/dev/null 2>&1; then
    echo "Branch '$branch' is not on origin; falling back to 'main' for Dedalus clone." >&2
    branch="main"
  fi
  echo "$branch"
}

command_json() {
  local command="$1"
  COMMAND_JSON_INPUT="$command" python3 - <<'PY'
import json
import os

print(json.dumps(["/bin/bash", "-lc", os.environ["COMMAND_JSON_INPUT"]]))
PY
}

run_execution() {
  local machine_id="$1"
  local command="$2"
  local stdin_source="${3:-}"
  local command_payload create_json execution_id status retrieve_json output_json

  command_payload="$(command_json "$command")"

  if [[ -n "$stdin_source" ]]; then
    create_json="$(
      dedalus machines:executions create \
        --machine-id "$machine_id" \
        --command "$command_payload" \
        --stdin "$stdin_source" \
        --format json \
        </dev/null
    )"
  else
    create_json="$(
      dedalus machines:executions create \
        --machine-id "$machine_id" \
        --command "$command_payload" \
        --format json \
        </dev/null
    )"
  fi

  execution_id="$(printf '%s' "$create_json" | json_get execution_id)"

  while true; do
    retrieve_json="$(
      dedalus machines:executions retrieve \
        --machine-id "$machine_id" \
        --execution-id "$execution_id" \
        --format json \
        </dev/null
    )"
    status="$(printf '%s' "$retrieve_json" | json_get status)"
    case "$status" in
      queued|running|wake_in_progress)
        sleep 1
        ;;
      succeeded)
        break
        ;;
      failed|cancelled|expired)
        output_json="$(
          dedalus machines:executions output \
            --machine-id "$machine_id" \
            --execution-id "$execution_id" \
            --format json \
            </dev/null
        )"
        DEDALUS_OUTPUT_JSON="$output_json" python3 - <<'PY'
import json
import os
import sys

data = json.loads(os.environ["DEDALUS_OUTPUT_JSON"])
stdout = data.get("stdout", "")
stderr = data.get("stderr", "")
if stdout:
    sys.stdout.write(stdout)
if stderr:
    sys.stderr.write(stderr)
PY
        return 1
        ;;
      *)
        echo "Unknown execution status: $status" >&2
        return 1
        ;;
    esac
  done

  output_json="$(
    dedalus machines:executions output \
      --machine-id "$machine_id" \
      --execution-id "$execution_id" \
      --format json \
      </dev/null
  )"
  DEDALUS_OUTPUT_JSON="$output_json" python3 - <<'PY'
import json
import os
import sys

data = json.loads(os.environ["DEDALUS_OUTPUT_JSON"])
stdout = data.get("stdout", "")
if stdout:
    sys.stdout.write(stdout)
PY
}

run_remote() {
  local machine_id="$1"
  local command="$2"
  run_execution "$machine_id" "$command"
}

copy_file_to_machine() {
  local machine_id="$1"
  local local_path="$2"
  local remote_path="$3"
  local parent_dir
  parent_dir="$(dirname "$remote_path")"

  run_remote "$machine_id" "mkdir -p $(printf '%q' "$parent_dir")"
  run_execution \
    "$machine_id" \
    "cat > $(printf '%q' "$remote_path")" \
    "@file://$local_path"
}

sync_repo_to_machine() {
  local machine_id="$1"
  local remote_dir="$2"
  local parent_dir
  local archive_path base64_path
  parent_dir="$(dirname "$remote_dir")"

  archive_path="$(mktemp "${TMPDIR:-/tmp}/voyager-dedalus-sync.XXXXXX.tgz")"
  base64_path="$(mktemp "${TMPDIR:-/tmp}/voyager-dedalus-sync.XXXXXX.b64")"

  tar \
    --exclude=".git" \
    --exclude=".venv" \
    --exclude="venv" \
    --exclude="node_modules" \
    --exclude="logs" \
    --exclude="photon-progress" \
    --exclude="ckpt*" \
    -czf "$archive_path" \
    -C "$APP_HOME" .

  base64 < "$archive_path" > "$base64_path"

  run_remote "$machine_id" "mkdir -p $(printf '%q' "$remote_dir") $(printf '%q' "$parent_dir")"
  run_execution \
    "$machine_id" \
    "base64 -d | tar -xzf - -C $(printf '%q' "$remote_dir")" \
    "@file://$base64_path"

  rm -f "$archive_path" "$base64_path"
}

sync_dedalus_scripts_to_machine() {
  local machine_id="$1"
  local remote_dir="$2"
  local rel_path

  while IFS= read -r rel_path; do
    copy_file_to_machine \
      "$machine_id" \
      "$APP_HOME/$rel_path" \
      "$remote_dir/$rel_path"
  done < <(
    cd "$APP_HOME"
    find scripts/dedalus -maxdepth 1 -type f \( -name '*.sh' -o -name '*.py' \) | sort
  )

  run_remote "$machine_id" "chmod +x $(printf '%q' "$remote_dir")/scripts/dedalus/"'*.sh'
}

wait_for_machine() {
  local machine_id="$1"
  local status_json phase

  while true; do
    status_json="$(dedalus machines retrieve --machine-id "$machine_id" --format json)"
    phase="$(printf '%s' "$status_json" | json_get status.phase)"
    if [[ "$phase" == "running" ]]; then
      break
    fi
    echo "Waiting for machine $machine_id to reach running state (current: $phase)..."
    sleep 2
  done
}

main() {
  ensure_dirs
  load_app_env

  if ! command -v dedalus >/dev/null 2>&1; then
    echo "dedalus CLI is not installed. Install it first with Homebrew or Go." >&2
    exit 1
  fi

  if [[ -z "${DEDALUS_API_KEY:-}" && -z "${DEDALUS_X_API_KEY:-}" ]]; then
    echo "Set DEDALUS_API_KEY (or DEDALUS_X_API_KEY) before provisioning." >&2
    exit 1
  fi

  local machine_id create_json repo_url branch remote_dir
  local vcpu memory_mib storage_gib
  vcpu="${DEDALUS_VCPU:-2}"
  memory_mib="${DEDALUS_MEMORY_MIB:-4096}"
  storage_gib="${DEDALUS_STORAGE_GIB:-25}"
  repo_url="$(infer_repo_url)"
  branch="$(infer_branch)"
  remote_dir="${DEDALUS_APP_REMOTE_DIR:-/home/machine/$(basename "$APP_HOME")}"
  local orchestrator_remote_dir
  orchestrator_remote_dir="${OPENCLAW_ORCHESTRATOR_PATH:-/home/machine/openclaw-orchestrator}"

  machine_id="${DEDALUS_MACHINE_ID:-}"
  if [[ -z "$machine_id" ]]; then
    create_json="$(
      dedalus machines create \
        --vcpu "$vcpu" \
        --memory-mib "$memory_mib" \
        --storage-gib "$storage_gib" \
        --format json
    )"
    machine_id="$(printf '%s' "$create_json" | json_get machine_id)"
    echo "Created Dedalus machine: $machine_id"
  else
    echo "Using existing Dedalus machine: $machine_id"
  fi

  wait_for_machine "$machine_id"

  local repo_url_q branch_q remote_dir_q
  printf -v repo_url_q '%q' "$repo_url"
  printf -v branch_q '%q' "$branch"
  printf -v remote_dir_q '%q' "$remote_dir"

  if [[ "${DEDALUS_SKIP_APT:-1}" == "1" ]]; then
    run_remote "$machine_id" \
      "command -v git >/dev/null 2>&1 || { echo 'git is required but missing and DEDALUS_SKIP_APT=1' >&2; exit 1; }"
  else
    run_remote "$machine_id" \
      "export DEBIAN_FRONTEND=noninteractive; command -v git >/dev/null 2>&1 || (apt-get update && apt-get install -y git ca-certificates)"
  fi

  if [[ "${DEDALUS_SYNC_LOCAL_REPO:-1}" == "1" ]]; then
    sync_repo_to_machine "$machine_id" "$remote_dir"
  else
    run_remote "$machine_id" \
      "mkdir -p /home/machine && if [[ -d $remote_dir_q/.git ]]; then git -C $remote_dir_q fetch origin --prune && git -C $remote_dir_q checkout $branch_q && git -C $remote_dir_q pull --ff-only origin $branch_q; else git clone --branch $branch_q $repo_url_q $remote_dir_q; fi"
  fi

  if [[ "${DEDALUS_SYNC_DEDALUS_SCRIPTS:-1}" == "1" ]]; then
    sync_dedalus_scripts_to_machine "$machine_id" "$remote_dir"
  fi

  local dedalus_skip_apt_q
  printf -v dedalus_skip_apt_q '%q' "${DEDALUS_SKIP_APT:-1}"
  run_remote "$machine_id" "cd $remote_dir_q && DEDALUS_SKIP_APT=$dedalus_skip_apt_q bash scripts/dedalus/bootstrap-machine.sh"

  local source_env_file
  source_env_file="${DEDALUS_SOURCE_ENV_FILE:-$APP_HOME/.env}"
  if [[ -f "$source_env_file" ]]; then
    python3 "$APP_HOME/scripts/dedalus/render-envs.py" \
      --source "$source_env_file" \
      --app-out "$APP_HOME/.env.dedalus" \
      --openclaw-out "$APP_HOME/.env.openclaw"

    copy_file_to_machine "$machine_id" "$APP_HOME/.env.dedalus" "$remote_dir/.env.dedalus"

    if [[ -n "${OPENCLAW_ORCHESTRATOR_REPO:-}" ]]; then
      copy_file_to_machine "$machine_id" "$APP_HOME/.env.openclaw" "$orchestrator_remote_dir/.env"
      run_remote "$machine_id" "chmod 600 $(printf '%q' "$orchestrator_remote_dir/.env")"
    fi
  else
    echo "Skipping env render: source env file not found at $source_env_file"
  fi

  if [[ -n "${OPENCLAW_ORCHESTRATOR_REPO:-}" ]]; then
    local orchestrator_repo_q orchestrator_branch_q
    printf -v orchestrator_repo_q '%q' "$OPENCLAW_ORCHESTRATOR_REPO"
    printf -v orchestrator_branch_q '%q' "${OPENCLAW_ORCHESTRATOR_BRANCH:-main}"

    run_remote "$machine_id" \
      "cd $remote_dir_q && OPENCLAW_ORCHESTRATOR_REPO=$orchestrator_repo_q OPENCLAW_ORCHESTRATOR_BRANCH=$orchestrator_branch_q bash scripts/dedalus/install-openclaw-orchestrator.sh"
  fi

  if [[ "${DEDALUS_START_STACK:-1}" == "1" ]]; then
    run_remote "$machine_id" "cd $remote_dir_q && bash scripts/dedalus/start-stack.sh"
  fi

  cat <<EOF
Dedalus provisioning complete.
Machine ID: $machine_id
Repo URL: $repo_url
Branch: $branch
Remote app dir: $remote_dir
Rendered app env: $remote_dir/.env.dedalus
Rendered OpenClaw env: $orchestrator_remote_dir/.env

Next useful commands:
  export DEDALUS_MACHINE_ID=$machine_id
  dedalus machines exec --machine-id $machine_id -- /bin/bash -lc 'cd $remote_dir && bash scripts/dedalus/status.sh'
EOF
}

main "$@"
