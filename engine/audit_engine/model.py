"""The optional language model behind evidence extraction and memo wording (PRD 21).

Two wire formats are supported. A local Ollama server keeps every request
inside the deployment (AI-2). A hosted service that speaks the chat
completions format can be used instead where a local model is impractical,
for example on a laptop with no GPU. The caller validates whatever comes
back and falls back to pattern rules or template text (AI-1, AI-3), so a
model that is slow, absent or out of quota never stops a step.
"""

from __future__ import annotations

import json
import logging
import re
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from functools import lru_cache
from typing import Callable, Iterable

log = logging.getLogger("audit_engine.model")


@lru_cache(maxsize=1)
def _http():
    """One connection pool for every call. A client per call would set up TLS again each time."""
    import httpx

    return httpx.Client()


@dataclass(frozen=True)
class Model:
    url: str
    name: str
    kind: str = "ollama"  # "ollama" or "chat"
    api_key: str | None = None
    workers: int = 1
    effort: str | None = None  # reasoning effort asked of a hosted model; hidden reasoning is billed as output
    timeout: float = 60.0

    def complete(self, prompt: str, schema: dict | None = None) -> str | None:
        """The model's text for one prompt, or None on any failure."""
        try:
            if self.kind == "ollama":
                body = {"model": self.name, "prompt": prompt, "stream": False, "options": {"temperature": 0}}
                if schema:
                    body["format"] = schema
                r = _http().post(f"{self.url.rstrip('/')}/api/generate", json=body, timeout=self.timeout)
                r.raise_for_status()
                return (r.json().get("response") or "").strip() or None
            # Temperature and response format are left at the service defaults:
            # reasoning models reject a temperature, and not every gateway accepts a response format.
            headers = {"Authorization": f"Bearer {self.api_key}"} if self.api_key else {}
            body = {"model": self.name, "messages": [{"role": "user", "content": prompt}]}
            if self.effort:
                body["reasoning_effort"] = self.effort
            for wait in (15, 30, 0):
                r = _http().post(_chat_url(self.url), headers=headers, timeout=self.timeout, json=body)
                if r.status_code != 429 or not wait:
                    break
                time.sleep(wait)  # A rate limit clears within a minute.
            r.raise_for_status()
            message = r.json()["choices"][0]["message"]
            return (message.get("content") or "").strip() or None
        except Exception as e:  # noqa: BLE001 - every failure falls back to rules or templates
            log.warning("model call failed (%s %s): %s", self.kind, self.name, _short(e))
            return None

    def complete_json(self, prompt: str, schema: dict | None = None) -> dict | None:
        """The model's answer parsed as one JSON object, or None."""
        return parse_object(self.complete(prompt, schema))

    def map(self, fn: Callable, items: Iterable) -> list:
        """Apply ``fn`` to each item, concurrently for a hosted model. The order of the results is the order of the items."""
        items = list(items)
        if self.workers <= 1 or len(items) <= 1:
            return [fn(x) for x in items]
        with ThreadPoolExecutor(max_workers=self.workers) as pool:
            return list(pool.map(fn, items))


def _chat_url(url: str) -> str:
    """The address requests are posted to. A base that ends in /v1 gets the usual path; any other address is used as given."""
    url = url.rstrip("/")
    return url + "/chat/completions" if url.endswith("/v1") else url


def _short(e: Exception) -> str:
    text = str(e)
    body = getattr(getattr(e, "response", None), "text", "")
    return (text + (" | " + body if body else ""))[:300]


def parse_object(text: str | None) -> dict | None:
    """A JSON object from model output that may be fenced or surrounded by prose."""
    if not text:
        return None
    text = re.sub(r"^```[a-zA-Z]*\s*|\s*```$", "", text.strip())
    for candidate in (text, text[text.find("{"): text.rfind("}") + 1]):
        try:
            data = json.loads(candidate)
        except (TypeError, ValueError):
            continue
        if isinstance(data, dict):
            return data
    return None
