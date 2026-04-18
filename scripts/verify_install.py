#!/usr/bin/env python3
"""Check that README install steps produced a usable tree (no Minecraft/OpenAI calls)."""
from __future__ import annotations

import os
import sys


def run_checks() -> int:
    """Return 0 if the install tree looks usable (no Minecraft / OpenAI calls)."""
    repo = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    os.chdir(repo)

    try:
        from voyager import Voyager  # noqa: F401
    except Exception as exc:
        print("FAIL: cannot import voyager:", exc, file=sys.stderr)
        return 1

    mineflayer = os.path.join(repo, "voyager", "env", "mineflayer")
    index_js = os.path.join(mineflayer, "index.js")
    if not os.path.isfile(index_js):
        print("FAIL: missing", index_js, file=sys.stderr)
        return 1

    nm = os.path.join(mineflayer, "node_modules")
    if not os.path.isdir(nm):
        print("FAIL: run npm install in voyager/env/mineflayer", file=sys.stderr)
        return 1

    collect_lib = os.path.join(
        mineflayer, "mineflayer-collectblock", "lib", "CollectBlock.js"
    )
    if not os.path.isfile(collect_lib):
        print(
            "FAIL: mineflayer-collectblock not built (missing",
            collect_lib + ").",
            "Run: (cd voyager/env/mineflayer/mineflayer-collectblock && npx tsc)",
            file=sys.stderr,
        )
        return 1

    print("OK: Python package imports; Mineflayer JS and collectblock build present.")
    print("Next: install Minecraft 1.19 + Fabric mods, then run Getting Started in README.md")
    return 0


def main() -> int:
    return run_checks()


if __name__ == "__main__":
    raise SystemExit(main())
