import os
import random
import time
from pathlib import Path

from langchain.schema import AIMessage
from openai import OpenAI
try:
    from dedalus_labs import Dedalus
except Exception:
    Dedalus = None

try:
    from openai import (
        APIConnectionError,
        APITimeoutError,
        InternalServerError,
        RateLimitError,
    )
except Exception:
    APIConnectionError = tuple()
    APITimeoutError = tuple()
    InternalServerError = tuple()
    RateLimitError = tuple()


_ENV_LOADED = False
_LEGACY_CEREBRAS_BASE_URL = "https://api.cerebras.ai/v1"
_LEGACY_CEREBRAS_MODEL = "k2-think-v2"
_DEFAULT_K2_BASE_URL = "https://api.k2think.ai/v1"
_DEFAULT_K2_MODEL = "MBZUAI-IFM/K2-Think-v2"
_DEFAULT_OPENAI_MODEL = "gpt-4o-2024-08-06"

_DEFAULT_OPENAI_MAX_RETRIES = int(os.getenv("OPENAI_MAX_RETRIES", "5"))
_DEFAULT_OPENAI_RETRY_BASE_SECONDS = float(
    os.getenv("OPENAI_RETRY_BASE_SECONDS", "0.75")
)
_DEFAULT_OPENAI_RETRY_MAX_SECONDS = float(
    os.getenv("OPENAI_RETRY_MAX_SECONDS", "8")
)


def load_env_file():
    global _ENV_LOADED
    if _ENV_LOADED:
        return

    repo_root = Path(__file__).resolve().parents[1]
    candidates = [Path.cwd() / ".env", repo_root / ".env"]

    seen = set()
    for candidate in candidates:
        resolved = candidate.resolve()
        if resolved in seen or not resolved.is_file():
            continue
        seen.add(resolved)
        _load_env_path(resolved)

    _ENV_LOADED = True


def _load_env_path(path: Path):
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export ") :]
        key, separator, value = line.partition("=")
        if not separator:
            continue
        key = key.strip()
        value = value.strip()
        if value and value[0] == value[-1] and value[0] in {"'", '"'}:
            value = value[1:-1]
        os.environ.setdefault(key, value)


class CerebrasChatModel:
    def __init__(
        self,
        model_name=_DEFAULT_OPENAI_MODEL,
        temperature=0,
        request_timeout=120,
    ):
        load_env_file()
        self.model_name = model_name or _resolve_chat_model()
        self.temperature = temperature
        self.request_timeout = request_timeout
        self.provider = _resolve_primary_llm_provider()
        if self.provider == "dedalus":
            if Dedalus is None:
                raise ValueError(
                    "DEDALUS_API_KEY is set but dedalus_labs is not installed. "
                    "Install it with `pip install dedalus-labs`."
                )
            api_key = (os.getenv("DEDALUS_API_KEY") or "").strip().strip("{}")
            if not api_key:
                raise ValueError(
                    "DEDALUS_API_KEY is not set. Add it to your environment or .env file."
                )
            client_kwargs = {
                "api_key": api_key,
                "timeout": request_timeout,
            }
            base_url = os.getenv("DEDALUS_BASE_URL")
            if base_url:
                client_kwargs["base_url"] = base_url
            self.client = Dedalus(**client_kwargs)
        else:
            api_key = _resolve_chat_api_key()
            if not api_key:
                raise ValueError(
                    "OPENAI_API_KEY is not set. Add it to your environment or .env file."
                )
            api_key = api_key.strip().strip("{}")
            client_kwargs = {
                "api_key": api_key,
                "timeout": request_timeout,
            }
            base_url = _resolve_chat_base_url()
            if base_url:
                client_kwargs["base_url"] = base_url
            self.client = OpenAI(**client_kwargs)
        self.max_retries = max(1, _DEFAULT_OPENAI_MAX_RETRIES)
        self.retry_base_seconds = max(0.1, _DEFAULT_OPENAI_RETRY_BASE_SECONDS)
        self.retry_max_seconds = max(
            self.retry_base_seconds, _DEFAULT_OPENAI_RETRY_MAX_SECONDS
        )

    def __call__(self, messages):
        response = _run_with_openai_retries(
            operation_name="chat.completions.create",
            fn=lambda: self.client.chat.completions.create(
                model=self.model_name,
                temperature=self.temperature,
                messages=[self._serialize_message(message) for message in messages],
            ),
            max_retries=self.max_retries,
            base_seconds=self.retry_base_seconds,
            max_seconds=self.retry_max_seconds,
        )
        content = response.choices[0].message.content or ""
        return AIMessage(content=content)

    @staticmethod
    def _serialize_message(message):
        role = getattr(message, "type", "")
        if role == "human":
            role = "user"
        elif role not in {"system", "assistant", "user"}:
            role = "assistant" if role == "ai" else "user"
        return {
            "role": role,
            "content": CerebrasChatModel._stringify_content(
                getattr(message, "content", "")
            ),
        }

    @staticmethod
    def _stringify_content(content):
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            parts = []
            for item in content:
                if isinstance(item, str):
                    parts.append(item)
                elif isinstance(item, dict):
                    parts.append(str(item.get("text", "")))
                else:
                    parts.append(str(item))
            return "\n".join(part for part in parts if part)
        return str(content)


class OpenAIEmbeddingFunction:
    def __init__(self, model_name=None, request_timeout=120):
        load_env_file()
        self.provider = _resolve_primary_llm_provider()

        if self.provider == "dedalus":
            if Dedalus is None:
                raise ValueError(
                    "DEDALUS_API_KEY is set but dedalus_labs is not installed. "
                    "Install it with `pip install dedalus-labs`."
                )
            api_key = os.getenv("DEDALUS_API_KEY")
            if not api_key:
                raise ValueError(
                    "DEDALUS_API_KEY is not set. Add it to your environment or .env file."
                )
            self.model_name = model_name or os.getenv(
                "DEDALUS_EMBEDDING_MODEL", "openai/text-embedding-3-small"
            )
            client_kwargs = {
                "api_key": api_key,
                "timeout": request_timeout,
            }
            base_url = os.getenv("DEDALUS_BASE_URL")
            if base_url:
                client_kwargs["base_url"] = base_url
            self.client = Dedalus(**client_kwargs)
        else:
            api_key = os.getenv("OPENAI_API_KEY")
            if not api_key:
                raise ValueError(
                    "OPENAI_API_KEY is not set. Add it to your environment or .env file."
                )
            self.model_name = model_name or os.getenv(
                "OPENAI_EMBEDDING_MODEL", "text-embedding-3-small"
            )
            client_kwargs = {
                "api_key": api_key,
                "timeout": request_timeout,
            }
            base_url = os.getenv("OPENAI_EMBEDDING_BASE_URL") or _resolve_chat_base_url()
            if base_url:
                client_kwargs["base_url"] = base_url
            self.client = OpenAI(**client_kwargs)
        self.max_retries = max(1, _DEFAULT_OPENAI_MAX_RETRIES)
        self.retry_base_seconds = max(0.1, _DEFAULT_OPENAI_RETRY_BASE_SECONDS)
        self.retry_max_seconds = max(
            self.retry_base_seconds, _DEFAULT_OPENAI_RETRY_MAX_SECONDS
        )

    def embed_documents(self, texts):
        if not texts:
            return []
        response = _run_with_openai_retries(
            operation_name="embeddings.create",
            fn=lambda: self.client.embeddings.create(
                model=self.model_name,
                input=texts,
                encoding_format="float",
            ),
            max_retries=self.max_retries,
            base_seconds=self.retry_base_seconds,
            max_seconds=self.retry_max_seconds,
        )
        return [item.embedding for item in response.data]

    def embed_query(self, text):
        return self.embed_documents([text])[0]


def _resolve_chat_base_url():
    # Dedalus takes precedence when enabled.
    dedalus_base_url = os.getenv("DEDALUS_BASE_URL")
    if dedalus_base_url and _resolve_primary_llm_provider() == "dedalus":
        return dedalus_base_url
    openai_base_url = os.getenv("OPENAI_BASE_URL")
    if openai_base_url:
        return openai_base_url
    k2_base_url = os.getenv("K2_BASE_URL")
    if k2_base_url:
        return k2_base_url
    legacy_base_url = os.getenv("CEREBRAS_BASE_URL")
    if legacy_base_url and legacy_base_url != _LEGACY_CEREBRAS_BASE_URL:
        return legacy_base_url
    return None


def _resolve_chat_model():
    dedalus_model = os.getenv("DEDALUS_MODEL")
    if dedalus_model and _resolve_primary_llm_provider() == "dedalus":
        return dedalus_model
    openai_model = os.getenv("OPENAI_MODEL")
    if openai_model:
        return openai_model
    k2_model = os.getenv("K2_MODEL")
    if k2_model:
        return k2_model
    legacy_model = os.getenv("CEREBRAS_MODEL")
    if legacy_model and legacy_model != _LEGACY_CEREBRAS_MODEL:
        return legacy_model
    return _DEFAULT_OPENAI_MODEL


def _resolve_chat_api_key():
    if _resolve_primary_llm_provider() == "dedalus":
        return os.getenv("DEDALUS_API_KEY")
    return (
        os.getenv("OPENAI_API_KEY")
        or os.getenv("K2_API_KEY")
        or os.getenv("CEREBRAS_API_KEY")
    )


def _resolve_primary_llm_provider():
    # Prefer Dedalus whenever an API key is provided.
    if os.getenv("DEDALUS_API_KEY"):
        return "dedalus"
    return "openai"


def _run_with_openai_retries(
    *,
    operation_name: str,
    fn,
    max_retries: int,
    base_seconds: float,
    max_seconds: float,
):
    attempts = max(1, int(max_retries))
    for attempt in range(1, attempts + 1):
        try:
            return fn()
        except Exception as error:
            should_retry = _is_retryable_openai_error(error)
            is_last_attempt = attempt >= attempts
            if not should_retry or is_last_attempt:
                raise
            delay_seconds = min(max_seconds, base_seconds * (2 ** (attempt - 1)))
            delay_seconds += random.uniform(0, delay_seconds * 0.2)
            print(
                f"[LLM] {operation_name} transient failure on attempt {attempt}/{attempts}: "
                f"{error}. Retrying in {delay_seconds:.2f}s..."
            )
            time.sleep(delay_seconds)


def _is_retryable_openai_error(error: Exception) -> bool:
    retryable_types = tuple(
        t
        for t in (
            APIConnectionError,
            APITimeoutError,
            RateLimitError,
            InternalServerError,
        )
        if isinstance(t, type)
    )
    if retryable_types and isinstance(error, retryable_types):
        return True

    message = str(error).lower()
    transient_tokens = (
        "connection aborted",
        "remote end closed connection",
        "remotedisconnected",
        "connection reset by peer",
        "timed out",
        "timeout",
        "temporarily unavailable",
        "service unavailable",
        "server error",
        "rate limit",
        "too many requests",
    )
    return any(token in message for token in transient_tokens)
