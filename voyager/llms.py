import os
from pathlib import Path

from langchain.schema import AIMessage
from openai import OpenAI


_ENV_LOADED = False
_LEGACY_CEREBRAS_BASE_URL = "https://api.cerebras.ai/v1"
_LEGACY_CEREBRAS_MODEL = "k2-think-v2"
_DEFAULT_K2_BASE_URL = "https://api.k2think.ai/v1"
_DEFAULT_K2_MODEL = "MBZUAI-IFM/K2-Think-v2"


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
        model_name=_DEFAULT_K2_MODEL,
        temperature=0,
        request_timeout=120,
    ):
        load_env_file()
        self.model_name = model_name or _resolve_chat_model()
        self.temperature = temperature
        self.request_timeout = request_timeout
        api_key = os.getenv("K2_API_KEY") or os.getenv("CEREBRAS_API_KEY")
        if not api_key:
            raise ValueError(
                "K2_API_KEY or CEREBRAS_API_KEY is not set. Add one to your environment or .env file."
            )
        api_key = api_key.strip().strip("{}")
        self.client = OpenAI(
            api_key=api_key,
            base_url=_resolve_chat_base_url(),
            timeout=request_timeout,
        )

    def __call__(self, messages):
        response = self.client.chat.completions.create(
            model=self.model_name,
            temperature=self.temperature,
            messages=[self._serialize_message(message) for message in messages],
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
        api_key = os.getenv("OPENAI_API_KEY")
        if not api_key:
            raise ValueError(
                "OPENAI_API_KEY is not set. Add it to your environment or .env file."
            )
        self.model_name = model_name or os.getenv(
            "OPENAI_EMBEDDING_MODEL", "text-embedding-3-small"
        )
        self.client = OpenAI(
            api_key=api_key,
            timeout=request_timeout,
        )

    def embed_documents(self, texts):
        if not texts:
            return []
        response = self.client.embeddings.create(
            model=self.model_name,
            input=texts,
        )
        return [item.embedding for item in response.data]

    def embed_query(self, text):
        return self.embed_documents([text])[0]


def _resolve_chat_base_url():
    k2_base_url = os.getenv("K2_BASE_URL")
    if k2_base_url:
        return k2_base_url
    legacy_base_url = os.getenv("CEREBRAS_BASE_URL")
    if legacy_base_url and legacy_base_url != _LEGACY_CEREBRAS_BASE_URL:
        return legacy_base_url
    return _DEFAULT_K2_BASE_URL


def _resolve_chat_model():
    k2_model = os.getenv("K2_MODEL")
    if k2_model:
        return k2_model
    legacy_model = os.getenv("CEREBRAS_MODEL")
    if legacy_model and legacy_model != _LEGACY_CEREBRAS_MODEL:
        return legacy_model
    return _DEFAULT_K2_MODEL
