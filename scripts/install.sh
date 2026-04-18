#!/usr/bin/env bash
# End-to-end local install matching README.md (Python + Mineflayer Node).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

pick_python() {
  for cmd in python3.12 python3.11 python3.10 python3.9 python3; do
    if command -v "$cmd" >/dev/null 2>&1; then
      ver="$("$cmd" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')"
      major="${ver%%.*}"
      minor="${ver#*.}"
      if [[ "$major" -eq 3 && "$minor" -ge 9 && "$minor" -le 12 ]]; then
        echo "$cmd"
        return
      fi
    fi
  done
  echo ""
}

PY="$(pick_python)"
if [[ -z "$PY" ]]; then
  echo "Need Python 3.9–3.12 on PATH (3.13+ is not supported yet due to native deps)." >&2
  exit 1
fi

echo "Using Python: $PY ($($PY --version))"

if [[ ! -d .venv ]]; then
  "$PY" -m venv .venv
fi
# shellcheck source=/dev/null
source .venv/bin/activate
python -m pip install -U pip setuptools wheel
python -m pip install -e .

echo "Installing Mineflayer (npm install runs TypeScript build via postinstall)..."
cd voyager/env/mineflayer
npm install

echo "Running smoke test (install tree + Mineflayer /health + optional LLM)..."
python scripts/smoke_test.py

echo "Done. Activate with: source .venv/bin/activate"
echo "Re-run checks: python scripts/verify_install.py  or  python scripts/smoke_test.py"
