#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
from pathlib import Path
import shlex


APP_ENV_KEYS = [
    "DEDALUS_API_KEY",
    "DEDALUS_X_API_KEY",
    "OPENAI_API_KEY",
    "OPENAI_MODEL",
    "OPENAI_EMBEDDING_MODEL",
    "VOYAGER_MC_HOST",
    "VOYAGER_MC_PORT",
    "VOYAGER_SERVER_PORT",
    "VOYAGER_BOT_USERNAME",
    "VOYAGER_MC_AUTH",
    "VOYAGER_MC_VERSION",
    "VOYAGER_MC_PASSWORD",
    "VOYAGER_MC_PROFILES_DIR",
    "VOYAGER_PATH",
    "VOYAGER_ORCHESTRATION_BACKEND",
    "IMESSAGE_BOT_ID",
    "PHOTON_PROJECT_ID",
    "PHOTON_PROJECT_SECRET",
    "PHOTON_TRACKING_DIR",
    "OPENCLAW_COMMAND",
    "OPENCLAW_ORCHESTRATOR_PATH",
    "OPENCLAW_ORCHESTRATOR_ENV_FILE",
    "OPENCLAW_FOREMAN_MATCH",
    "OPENCLAW_WORKER_IDS",
    "OPENCLAW_GATEWAY_ENV_FILE",
    "OPENCLAW_ENABLE_GATEWAYS",
    "OPENCLAW_ORCHESTRATOR_REPO",
    "OPENCLAW_ORCHESTRATOR_BRANCH",
]

OPENCLAW_ENV_KEYS = [
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "OPENAI_API_KEY",
    "OPENAI_MODEL",
    "OPENAI_EMBEDDING_MODEL",
    "VOYAGER_PATH",
    "VOYAGER_PYTHON",
    "VOYAGER_SIMULATION_MODE",
    "VOYAGER_MC_HOST",
    "VOYAGER_MC_PORT",
    "VOYAGER_MC_AUTH",
    "VOYAGER_MC_VERSION",
    "VOYAGER_MC_PASSWORD",
    "VOYAGER_MC_PROFILES_DIR",
    "VOYAGER_ACTION_MODEL",
    "VOYAGER_CURRICULUM_MODEL",
    "VOYAGER_CRITIC_MODEL",
    "VOYAGER_SKILL_MODEL",
    "VOYAGER_OPENAI_TIMEOUT",
]


def parse_env_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.exists():
      return values
    for raw_line in path.read_text().splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if (
            (value.startswith('"') and value.endswith('"'))
            or (value.startswith("'") and value.endswith("'"))
        ):
            value = value[1:-1]
        values[key] = value
    return values


def render_env(keys: list[str], values: dict[str, str], defaults: dict[str, str]) -> str:
    lines: list[str] = []
    for key in keys:
        value = values.get(key, defaults.get(key))
        if value in (None, ""):
            continue
        lines.append(f"{key}={shlex.quote(str(value))}")
    return "\n".join(lines) + ("\n" if lines else "")


def coerce_machine_paths(values: dict[str, str], app_home: str, orchestrator_home: str) -> dict[str, str]:
    result = dict(values)

    voyager_path = result.get("VOYAGER_PATH", "")
    if not voyager_path or voyager_path == "/path/to/voyager-repo" or voyager_path.startswith("/Users/"):
        result["VOYAGER_PATH"] = app_home

    openclaw_path = result.get("OPENCLAW_ORCHESTRATOR_PATH", "")
    if not openclaw_path or openclaw_path.startswith("/opt/") or openclaw_path.startswith("/Users/"):
        result["OPENCLAW_ORCHESTRATOR_PATH"] = orchestrator_home

    backend = (result.get("VOYAGER_ORCHESTRATION_BACKEND") or "").strip().lower()
    if backend not in {"local", "openclaw", "dedalus"}:
        backend = "local"
    result["VOYAGER_ORCHESTRATION_BACKEND"] = "openclaw" if backend in {"openclaw", "dedalus"} else "local"

    result["OPENCLAW_ORCHESTRATOR_ENV_FILE"] = f"{orchestrator_home}/.env"
    if result["VOYAGER_ORCHESTRATION_BACKEND"] == "openclaw":
        result["OPENCLAW_COMMAND"] = f"node {app_home}/scripts/photon-stdin-bridge.mjs"
    else:
        result.pop("OPENCLAW_COMMAND", None)
    result["PHOTON_TRACKING_DIR"] = "/home/machine/photon-progress"
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description="Render Dedalus env files from local .env")
    parser.add_argument("--source", default=".env", help="Source env file")
    parser.add_argument("--app-out", default=".env.dedalus", help="Rendered app env output")
    parser.add_argument(
        "--openclaw-out",
        default=".env.openclaw",
        help="Rendered OpenClaw env output",
    )
    args = parser.parse_args()

    source_path = Path(args.source)
    values = parse_env_file(source_path)

    app_home = os.environ.get("DEDALUS_APP_REMOTE_DIR", "/home/machine/Voyager-1")
    orchestrator_home = os.environ.get(
        "OPENCLAW_ORCHESTRATOR_PATH", "/home/machine/openclaw-orchestrator"
    )
    values = coerce_machine_paths(values, app_home, orchestrator_home)

    app_defaults = {
        "VOYAGER_PATH": app_home,
        "VOYAGER_ORCHESTRATION_BACKEND": "local",
        "PHOTON_TRACKING_DIR": "/home/machine/photon-progress",
        "OPENCLAW_ORCHESTRATOR_PATH": orchestrator_home,
        "OPENCLAW_ORCHESTRATOR_ENV_FILE": f"{orchestrator_home}/.env",
        "OPENCLAW_FOREMAN_MATCH": "node src/services/run-foreman.js",
        "OPENCLAW_WORKER_IDS": "worker-miner worker-builder",
        "OPENCLAW_GATEWAY_ENV_FILE": "/home/machine/openclaw-gateways/openclaw-gateway.env",
    }

    openclaw_defaults = {
        "VOYAGER_PATH": app_home,
        "VOYAGER_PYTHON": "/home/machine/.venvs/voyager/bin/python",
        "VOYAGER_SIMULATION_MODE": "false",
        "VOYAGER_ACTION_MODEL": "gpt-4o-mini",
        "VOYAGER_CURRICULUM_MODEL": "gpt-4o-mini",
        "VOYAGER_CRITIC_MODEL": "gpt-4o-mini",
        "VOYAGER_SKILL_MODEL": "gpt-4o-mini",
        "VOYAGER_OPENAI_TIMEOUT": "90",
    }

    Path(args.app_out).write_text(render_env(APP_ENV_KEYS, values, app_defaults))
    Path(args.openclaw_out).write_text(render_env(OPENCLAW_ENV_KEYS, values, openclaw_defaults))


if __name__ == "__main__":
    main()
