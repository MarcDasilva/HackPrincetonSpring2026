#!/usr/bin/env python3
"""
End-to-end smoke test (run from repo root with venv active):

1. Same tree checks as verify_install.py (imports, Mineflayer build).
2. Mineflayer Express server: start node on a free port, GET /health, then stop.
3. Optional LLM: if K2THINK_API_KEY + K2THINK_API_BASE (or OPENAI_*), one ChatOpenAI invoke.

Exit 0 if all required phases pass. LLM phase is skipped (still exit 0) if no API credentials.
"""
from __future__ import annotations

import importlib.util
import os
import socket
import subprocess
import sys
import time
from pathlib import Path

import requests

REPO = Path(__file__).resolve().parent.parent
MINEFLAYER_DIR = REPO / "voyager" / "env" / "mineflayer"
INDEX_JS = MINEFLAYER_DIR / "index.js"


def _load_verify_install():
    path = REPO / "scripts" / "verify_install.py"
    spec = importlib.util.spec_from_file_location("voyager_verify_install", path)
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


def _free_port() -> int:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(("127.0.0.1", 0))
    _, port = s.getsockname()
    s.close()
    return int(port)


def phase_install_tree() -> None:
    print("== Smoke: install tree (verify_install) ==")
    mod = _load_verify_install()
    rc = mod.run_checks()
    if rc != 0:
        raise SystemExit(rc)
    print("OK: install tree\n")


def phase_mineflayer_server(timeout_s: float = 45.0) -> None:
    print("== Smoke: Mineflayer HTTP server ==")
    if not INDEX_JS.is_file():
        print(f"FAIL: missing {INDEX_JS}", file=sys.stderr)
        raise SystemExit(1)

    port = _free_port()
    proc = subprocess.Popen(
        ["node", str(INDEX_JS), str(port)],
        cwd=str(MINEFLAYER_DIR),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    url = f"http://127.0.0.1:{port}/health"
    deadline = time.monotonic() + timeout_s
    try:
        while time.monotonic() < deadline:
            if proc.poll() is not None:
                print(
                    f"FAIL: Mineflayer node exited early (code {proc.returncode})",
                    file=sys.stderr,
                )
                raise SystemExit(1)
            try:
                r = requests.get(url, timeout=1.5)
                if r.status_code == 200 and r.json().get("ok") is True:
                    print(f"OK: GET {url} -> {r.text.strip()}\n")
                    return
            except (requests.RequestException, ValueError, OSError):
                pass
            time.sleep(0.15)
        print(f"FAIL: /health did not return ok=true within {timeout_s}s ({url})", file=sys.stderr)
        raise SystemExit(1)
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=8)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=3)


def phase_llm_optional() -> None:
    print("== Smoke: LLM (optional) ==")
    os.chdir(str(REPO))
    try:
        from voyager._env_loader import load_voyager_dotenv
        from voyager.voyager import _clean_env_secret, _normalize_openai_api_base
    except ImportError as e:
        print(f"SKIP: LLM ({e})", file=sys.stderr)
        return

    load_voyager_dotenv()
    key = _clean_env_secret(os.environ.get("K2THINK_API_KEY")) or _clean_env_secret(
        os.environ.get("OPENAI_API_KEY")
    )
    base = _normalize_openai_api_base(
        _clean_env_secret(os.environ.get("K2THINK_API_BASE"))
        or _clean_env_secret(os.environ.get("OPENAI_API_BASE"))
        or ""
    )
    model = (
        _clean_env_secret(os.environ.get("K2THINK_MODEL"))
        or _clean_env_secret(os.environ.get("VOYAGER_CHAT_MODEL"))
        or "MBZUAI-IFM/K2-Think-v2"
    )

    if not key or not base:
        print(
            "SKIP: set K2THINK_API_KEY + K2THINK_API_BASE (or OPENAI_*) to run LLM smoke.\n"
        )
        return

    os.environ["OPENAI_API_KEY"] = key
    from langchain.chat_models import ChatOpenAI

    llm = ChatOpenAI(
        model_name=model,
        temperature=0,
        request_timeout=120,
        openai_api_base=base,
        openai_api_key=key,
    )
    out = llm.invoke("Reply with exactly: pong")
    text = getattr(out, "content", str(out))
    print(f"OK: LLM model={model!r} response_len={len(text)}\n")


def main() -> int:
    phase_install_tree()
    phase_mineflayer_server()
    phase_llm_optional()
    print("Smoke test passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
