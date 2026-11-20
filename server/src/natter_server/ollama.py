"""Bounded, local-only standby for Claude. Never pulls a model or uses a cloud route."""

import asyncio
import json
import logging
import os
import time
from collections.abc import Awaitable, Callable
from typing import TypeVar

import anthropic
import httpx
import jsonschema
from claude_agent_sdk import ClaudeSDKError

from . import claude_code

log = logging.getLogger("natter.ollama")
T = TypeVar("T")
PRIMARY_TIMEOUT = 4
LOCAL_TIMEOUT = 7


class LocalError(Exception):
    pass


def unavailable(error: Exception) -> bool:
    if isinstance(error, anthropic.APIStatusError):
        return error.status_code == 429 or error.status_code >= 500
    return isinstance(
        error,
        (
            TimeoutError,
            anthropic.APIConnectionError,
            claude_code.AnswerError,
            ClaudeSDKError,
        ),
    )


class Fallback:
    def __init__(self):
        self.retry_at = 0.0
        self.local_ready: bool | None = None
        self._probe = False
        self._local_lock = asyncio.Lock()

    @property
    def model(self) -> str:
        # Empty disables standby. The 8B model passed the local idea-generation trial.
        return os.environ.get("NATTER_OLLAMA_MODEL", "qwen3:8b")

    @property
    def active(self) -> bool:
        return bool(self.model) and time.monotonic() < self.retry_at

    async def run(
        self, primary: Callable[[], Awaitable[T]], local: Callable[[], Awaitable[T]]
    ) -> T:
        if not self.model:
            return await primary()
        if self.active or self._probe:
            return await self._local(local)
        previous_retry = self.retry_at
        recovering = bool(previous_retry)
        if recovering:
            self._probe = True
        try:
            try:
                # The lab waits 12 seconds: four for Claude plus seven locally leaves a margin.
                async with asyncio.timeout(PRIMARY_TIMEOUT):
                    result = await primary()
            except Exception as error:
                if not unavailable(error):
                    raise
                self.retry_at = time.monotonic() + 60
                log.warning(
                    "Claude unavailable; using local %s for 60s (%s)",
                    self.model,
                    type(error).__name__,
                )
            else:
                if self.retry_at == previous_retry:
                    self.retry_at = 0
                    self.local_ready = None
                return result
        finally:
            if recovering:
                self._probe = False
        return await self._local(local)

    async def _local(self, call: Callable[[], Awaitable[T]]) -> T:
        try:
            result = await call()
        except Exception:
            self.local_ready = False
            raise
        self.local_ready = True
        return result

    async def chat(
        self, system: str, prompt: str, max_tokens: int, schema: dict | str = "json"
    ) -> str:
        try:
            # Includes queue time: concurrent gestures cannot build an unbounded inference queue.
            async with asyncio.timeout(LOCAL_TIMEOUT):
                async with self._local_lock:
                    async with httpx.AsyncClient(trust_env=False) as client:
                        response = await client.post(
                            "http://127.0.0.1:11434/api/chat",
                            json={
                                "model": self.model,
                                "messages": [
                                    {"role": "system", "content": system},
                                    {"role": "user", "content": prompt},
                                ],
                                "stream": False,
                                "think": False,
                                "format": schema,
                                "keep_alive": "1m",
                                "options": {
                                    "temperature": 0,
                                    "num_predict": max_tokens,
                                    "num_ctx": 8192,
                                },
                            },
                            timeout=10,
                        )
                        response.raise_for_status()
                        data = response.json()
            if (
                not isinstance(data, dict)
                or not data.get("done")
                or data.get("done_reason") == "length"
            ):
                raise LocalError("Local model did not finish its answer")
            content = data["message"]["content"]
            if not isinstance(content, str) or not isinstance(
                json.loads(content), dict
            ):
                raise LocalError("Local model did not return a JSON object")
            if isinstance(schema, dict):
                jsonschema.validate(json.loads(content), schema)
            return content
        except (
            httpx.HTTPError,
            ValueError,
            KeyError,
            TypeError,
            jsonschema.ValidationError,
        ) as error:
            raise LocalError(
                "Ollama unavailable or returned an invalid answer"
            ) from error


fallback = Fallback()
