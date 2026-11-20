"""Resolve commands through the user's Claude Code login instead of an API key.

Starting Claude Code takes about 3 s, so each model gets one long-lived session that
answers every command. The tool list is sent once per session, not with every command,
and the session's history grows by a board per command, so it is replaced every
RECYCLE_AFTER commands. Claude answers with JSON naming the same tools
the API path uses, rather than calling tools, because each tool round trip would add
another model turn.

The Agent SDK client must stay in the task that connected it, so a worker task owns
each session and callers hand it prompts through a queue.
"""

import asyncio
import contextlib
import json
import logging

from claude_agent_sdk import AssistantMessage, ClaudeAgentOptions, ClaudeSDKClient, ResultMessage, TextBlock

log = logging.getLogger("natter.claude-code")
RECYCLE_AFTER = 8

ANSWER_FORMAT = """- Answer with only a JSON object, no other text: {"calls": [{"name": "<tool name>", "input": {...}}]}. Each call names one of the tools in <tools> and gives an input that matches its input_schema. List board actions in the order they should run.
- Every message is a separate command. Earlier messages in this conversation are not context; only <previous_turn> is. The exception is <tools>: it is sent once and stays in force until a new <tools> block replaces it."""


class AnswerError(Exception):
    """Claude Code answered, but not with the JSON we asked for."""


def parse_calls(text: str) -> list[dict]:
    """Pull {"calls": [...]} out of the answer, tolerating a Markdown code fence around it."""
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end < start:
        raise AnswerError(f"no JSON object in {text[:200]!r}")
    try:
        calls = json.loads(text[start : end + 1]).get("calls")
    except (json.JSONDecodeError, AttributeError) as e:
        raise AnswerError(f"bad JSON: {e}") from e
    if not isinstance(calls, list) or not all(isinstance(c, dict) and isinstance(c.get("name"), str) for c in calls):
        raise AnswerError(f"calls is not a list of named calls: {calls!r}")
    return [{"name": c["name"], "input": c.get("input") or {}} for c in calls]


class Session:
    def __init__(self, model: str, system: str, thinking: bool = True, recycle_after: int = RECYCLE_AFTER):
        self.model = model
        self.system = system
        self.recycle_after = recycle_after
        # Claude Code thinks by default; for Haiku that tripled the time per command (1.5-6 s vs under 1 s).
        self.env = {} if thinking else {"MAX_THINKING_TOKENS": "0"}
        self._queue: asyncio.Queue[tuple[str | None, str, asyncio.Future]] = asyncio.Queue()
        self._worker: asyncio.Task | None = None
        self._busy = False

    @property
    def pending(self) -> int:
        """Requests waiting or running, including ones whose caller has given up."""
        return self._queue.qsize() + self._busy

    def start(self) -> None:
        if self._worker is None or self._worker.done():
            self._worker = asyncio.get_running_loop().create_task(self._run(), name=f"claude-code {self.model}")

    async def ask(self, prompt: str, tools: str, timeout: float) -> tuple[list[dict], dict]:
        """Return the calls Claude chose, and a record for the trace. Raises TimeoutError or AnswerError.

        A caller that gives up (timeout or cancellation) leaves its request behind; the worker
        skips it if it hasn't started, so it doesn't hold up the next command."""
        text, record = await self.ask_text(prompt, tools, timeout)
        return parse_calls(text), record

    async def ask_text(self, prompt: str, tools: str | None, timeout: float) -> tuple[str, dict]:
        """Return Claude's answer as text. `tools` None sends no <tools> block."""
        self.start()
        answer = asyncio.get_running_loop().create_future()
        await self._queue.put((tools, prompt, answer))
        try:
            return await asyncio.wait_for(asyncio.shield(answer), timeout)
        finally:
            answer.cancel()

    async def _run(self) -> None:
        # setting_sources=[] keeps the user's hooks, plugins and CLAUDE.md out of this session.
        options = ClaudeAgentOptions(
            model=self.model,
            system_prompt=self.system,
            tools=[],
            setting_sources=[],
            strict_mcp_config=True,
            max_turns=1,
            env=self.env,
        )
        while True:
            client = ClaudeSDKClient(options)
            sent_tools = None
            try:
                await client.connect()
                answered = 0
                while answered < self.recycle_after:
                    tools, prompt, answer = await self._queue.get()
                    if answer.done():  # its caller already gave up
                        continue
                    if tools != sent_tools:
                        prompt = f"<tools>\n{tools}\n</tools>\n{prompt}"
                    self._busy = True
                    try:
                        result = await self._exchange(client, prompt)
                    except Exception as e:
                        if not answer.done():
                            answer.set_exception(e)
                        raise
                    finally:
                        self._busy = False
                    sent_tools = tools
                    answered += 1
                    if not answer.done():  # a caller that timed out has gone; drop its late answer
                        answer.set_result(result)
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("Claude Code session for %s failed; starting a new one", self.model)
                await asyncio.sleep(1)
            finally:
                with contextlib.suppress(Exception):
                    await client.disconnect()

    async def _exchange(self, client: ClaudeSDKClient, prompt: str) -> tuple[str, dict]:
        await client.query(prompt)
        text, result = "", None
        async for message in client.receive_response():
            if isinstance(message, AssistantMessage):
                text += "".join(b.text for b in message.content if isinstance(b, TextBlock))
            elif isinstance(message, ResultMessage):
                result = message
        if result is None or result.is_error:
            raise AnswerError(f"Claude Code error: {result and (result.errors or result.result)}")
        return text, {"text": text, "usage": result.usage or {}, "backend": "claude_code"}


class Pool:
    """Several sessions on one model, so a command needn't queue behind one still running,
    such as a head-start guess for words the speaker has since added to."""

    def __init__(self, sessions: list[Session]):
        self.sessions = sessions

    @property
    def idle(self) -> bool:
        return any(s.pending == 0 for s in self.sessions)

    def start(self) -> None:
        for session in self.sessions:
            session.start()

    async def ask(self, prompt: str, tools: str, timeout: float) -> tuple[list[dict], dict]:
        session = min(self.sessions, key=lambda s: s.pending)
        return await session.ask(prompt, tools, timeout)
