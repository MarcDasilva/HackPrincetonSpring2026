from __future__ import annotations

import json
import os
import shlex
import subprocess
from typing import Any, Dict, Iterable, List


_FALSEY_ENV_VALUES = {"0", "false", "no", "off"}


def _normalize_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value.strip()
    return str(value).strip()


def _parse_bool_env(value: str | None, default: bool) -> bool:
    if value is None:
        return default
    return value.strip().lower() not in _FALSEY_ENV_VALUES


def _unique_strings(values: Iterable[str]) -> List[str]:
    seen = set()
    deduped: List[str] = []
    for value in values:
        text = _normalize_text(value)
        if not text or text in seen:
            continue
        seen.add(text)
        deduped.append(text)
    return deduped


class MCPContextBridge:
    def __init__(
        self,
        *,
        enabled: bool | None = None,
        command: str | None = None,
        timeout_sec: float | None = None,
        max_context_chars: int | None = None,
    ):
        env_command = _normalize_text(os.getenv("VOYAGER_MCP_CONTEXT_COMMAND"))
        self.command = _normalize_text(command) or env_command
        self.enabled = (
            _parse_bool_env(os.getenv("VOYAGER_MCP_CONTEXT_ENABLED"), bool(self.command))
            if enabled is None
            else bool(enabled)
        )
        env_timeout = _normalize_text(os.getenv("VOYAGER_MCP_CONTEXT_TIMEOUT_SEC"))
        try:
            default_timeout = float(env_timeout) if env_timeout else 12.0
        except ValueError:
            default_timeout = 12.0
        self.timeout_sec = float(timeout_sec) if timeout_sec is not None else default_timeout
        env_max_chars = _normalize_text(os.getenv("VOYAGER_MCP_CONTEXT_MAX_CHARS"))
        try:
            default_max_chars = int(env_max_chars) if env_max_chars else 900
        except ValueError:
            default_max_chars = 900
        self.max_context_chars = (
            int(max_context_chars) if max_context_chars is not None else default_max_chars
        )
        self._warned_missing_command = False

    @property
    def ready(self) -> bool:
        return self.enabled and bool(self.command)

    def enrich_task_context(
        self,
        *,
        task: str,
        context: str = "",
        observation: Dict[str, Any] | None = None,
        completed_tasks: List[str] | None = None,
        failed_tasks: List[str] | None = None,
        phase: str = "pre_rollout",
    ) -> Dict[str, Any]:
        normalized_task = _normalize_text(task)
        normalized_context = _normalize_text(context)
        if not normalized_task:
            return {
                "task": normalized_task,
                "context": normalized_context,
                "used": False,
                "source": None,
                "error": None,
            }

        if not self.enabled:
            return {
                "task": normalized_task,
                "context": normalized_context,
                "used": False,
                "source": None,
                "error": None,
            }

        if not self.command:
            if not self._warned_missing_command:
                print(
                    "\033[33mMCP context bridge enabled but VOYAGER_MCP_CONTEXT_COMMAND is empty.\033[0m"
                )
                self._warned_missing_command = True
            return {
                "task": normalized_task,
                "context": normalized_context,
                "used": False,
                "source": None,
                "error": "missing_command",
            }

        payload = {
            "phase": phase,
            "task": normalized_task,
            "context": normalized_context,
            "observation": observation or {},
            "completed_tasks": completed_tasks or [],
            "failed_tasks": failed_tasks or [],
        }

        try:
            response_payload = self._invoke_command(payload)
        except Exception as error:
            return {
                "task": normalized_task,
                "context": normalized_context,
                "used": False,
                "source": None,
                "error": str(error),
            }

        suggested_task = _normalize_text(response_payload.get("task"))
        suggested_context = self._extract_context_text(response_payload)

        final_task = suggested_task or normalized_task
        merged_context = self._merge_context(
            base_context=normalized_context,
            suggested_context=suggested_context,
        )

        used = final_task != normalized_task or merged_context != normalized_context
        return {
            "task": final_task,
            "context": merged_context,
            "used": used,
            "source": response_payload.get("source"),
            "error": None,
            "raw": response_payload,
        }

    def _invoke_command(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        process = subprocess.run(
            shlex.split(self.command),
            input=json.dumps(payload),
            text=True,
            capture_output=True,
            timeout=self.timeout_sec,
            check=False,
        )
        if process.returncode != 0:
            stderr = _normalize_text(process.stderr)
            raise RuntimeError(
                f"MCP context command failed with exit code {process.returncode}: {stderr}"
            )

        output = _normalize_text(process.stdout)
        if not output:
            return {}

        decoded = self._decode_json_output(output)
        if isinstance(decoded, dict):
            return decoded
        if isinstance(decoded, str):
            return {"context": decoded}
        if isinstance(decoded, list):
            lines = [_normalize_text(item) for item in decoded]
            return {"context_lines": [line for line in lines if line]}
        return {"context": _normalize_text(decoded)}

    def _decode_json_output(self, output: str) -> Any:
        try:
            return json.loads(output)
        except json.JSONDecodeError:
            pass

        lines = [line.strip() for line in output.splitlines() if line.strip()]
        if lines:
            try:
                return json.loads(lines[-1])
            except json.JSONDecodeError:
                return output
        return output

    def _extract_context_text(self, payload: Dict[str, Any]) -> str:
        parts: List[str] = []
        context_text = _normalize_text(payload.get("context"))
        if context_text:
            parts.append(context_text)

        context_lines = payload.get("context_lines")
        if isinstance(context_lines, list):
            lines = [_normalize_text(line) for line in context_lines]
            lines = [line for line in lines if line]
            if lines:
                parts.append("MCP context:\n" + "\n".join(f"- {line}" for line in lines))

        return "\n\n".join(parts).strip()

    def _merge_context(self, *, base_context: str, suggested_context: str) -> str:
        merged_parts = _unique_strings([base_context, suggested_context])
        merged = "\n\n".join(merged_parts).strip()
        if len(merged) <= self.max_context_chars:
            return merged
        return f"{merged[: max(self.max_context_chars - 3, 0)].rstrip()}..."
