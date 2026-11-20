"""Turn one utterance into a ResolverResult (SPEC §7).

One role, three tiers: grammar, then Claude Haiku 4.5, then Claude Sonnet 5.5 when
Haiku asks for clarification or proposes calls that fail validation. The resolver
never changes the scene; the browser's CommandBus applies (and re-validates) calls.

With ANTHROPIC_API_KEY set, Claude is called through the API. Without one, it goes
through the user's Claude Code login (claude_code.py), which is slower per turn.
"""

import asyncio
import json
import os
import time
from dataclasses import dataclass, field

import anthropic
import jsonschema
from claude_agent_sdk import ClaudeSDKError

from . import claude_code, grammar, ollama

FAST_MODEL = "claude-haiku-4-5"
STRONG_MODEL = "claude-sonnet-5-5"

SYSTEM = """You turn one spoken command into actions on a shared visual board.

Several people stand in front of a big screen showing the board. One of them raised a hand and said the utterance you receive. Speech recognition can mishear words, so read the utterance generously and match it against what is on the board.

You receive:
- the board: every object with its id, its on-screen number, kind, label, colour, size, group and position (x and y run from 0 to 1, left to right and top to bottom)
- the previous turn, so corrections like "no, the other one" or "and make them bigger" make sense
- the utterance

How to answer:
- Answer only by calling tools. Call one or more board actions, in the order they should run.
- Only use object ids that appear on the board. "Number 4" or "four" means the object whose number is 4. "Them", "those" or "it" usually mean the objects from the previous turn.
- Pick sensible values for anything the speaker left out (a colour, a free spot, a short label) rather than asking.
- If the utterance could mean two or three specific different things and guessing wrong would annoy people, call clarify with a short question and the candidate object ids.
- If the utterance is conversation rather than a command (people talking to each other), call no_action with reason "not_a_command".
- If it is a command but no available action can do it, call no_action with reason "no_matching_action" and say briefly why."""

API_ANSWER = "- Answer only by calling tools. Call one or more board actions, in the order they should run."
assert API_ANSWER in SYSTEM
CLAUDE_CODE_SYSTEM = SYSTEM.replace(API_ANSWER, claude_code.ANSWER_FORMAT).replace(", call ", ", name ")

CLARIFY_TOOL = {
    "name": "clarify",
    "description": "Ask the room a short question when the command is genuinely ambiguous.",
    "input_schema": {
        "type": "object",
        "properties": {
            "question": {"type": "string", "description": "Short question, e.g. 'The blue one or the green one?'"},
            "candidates": {"type": "array", "items": {"type": "string"}, "description": "Object ids the question is choosing between"},
        },
        "required": ["question"],
        "additionalProperties": False,
    },
}

NO_ACTION_TOOL = {
    "name": "no_action",
    "description": "Use when the utterance is not a command, or no available action can do it.",
    "input_schema": {
        "type": "object",
        "properties": {
            "reason": {"type": "string", "enum": ["not_a_command", "no_matching_action"]},
            "explanation": {"type": "string"},
        },
        "required": ["reason"],
        "additionalProperties": False,
    },
}

ID_FIELDS = ("id", "ids", "near")
# Claude Code turns take 1.5-3.5 s against the API's ~1 s; the browser waits 20 s in all.
CLAUDE_CODE_TIMEOUT = {FAST_MODEL: 8, STRONG_MODEL: 11}


@dataclass
class Resolution:
    result: dict
    tier: str
    attempts: list[dict] = field(default_factory=list)


def has_credentials() -> bool:
    return bool(os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"))


def build_tools(actions: list[dict]) -> list[dict]:
    tools = [
        {"name": a["name"], "description": a["description"], "input_schema": a["input_schema"]}
        for a in actions
    ]
    return tools + [CLARIFY_TOOL, NO_ACTION_TOOL]


def build_user_message(text: str, scene: dict, previous: dict | None) -> str:
    board = {
        "objects": scene.get("objects", []),
        "groups": scene.get("groups", []),
        "selection": scene.get("selection", []),
    }
    parts = [f"<board>\n{json.dumps(board, separators=(',', ':'))}\n</board>"]
    if previous:
        parts.append(f"<previous_turn>\n{json.dumps(previous, separators=(',', ':'))}\n</previous_turn>")
    parts.append(f"<utterance>{text}</utterance>")
    return "\n".join(parts)


def validate_calls(calls: list[dict], actions: list[dict], scene: dict) -> list[str]:
    """Return problems with proposed calls; empty means every call is runnable."""
    schemas = {a["name"]: a["input_schema"] for a in actions}
    ids = {o["id"] for o in scene.get("objects", [])}
    problems = []
    for call in calls:
        schema = schemas.get(call["name"])
        if schema is None:
            problems.append(f"{call['name']}: not an available action")
            continue
        try:
            jsonschema.validate(call["input"], schema)
        except jsonschema.ValidationError as e:
            problems.append(f"{call['name']}: {e.message}")
            continue
        for key in ID_FIELDS:
            value = call["input"].get(key)
            refs = value if isinstance(value, list) else [value] if isinstance(value, str) else []
            unknown = [r for r in refs if r not in ids]
            if unknown:
                problems.append(f"{call['name']}: unknown object ids {unknown}")
    return problems


def interpret(tool_uses: list[dict], scene_version: int) -> dict:
    """Map the model's tool calls to a ResolverResult."""
    if not tool_uses:
        return {"kind": "error", "reason": "model_failed"}
    for use in tool_uses:
        if use["name"] == "clarify":
            return {"kind": "clarify", "question": use["input"].get("question", "Which one?"), "candidates": use["input"].get("candidates", [])}
    calls = [u for u in tool_uses if u["name"] != "no_action"]
    if not calls:
        first = tool_uses[0]["input"]
        return {"kind": "none", "reason": first.get("reason", "no_matching_action"), "explanation": first.get("explanation", "")}
    return {"kind": "actions", "calls": calls, "sceneVersion": scene_version}


class Resolver:
    def __init__(self, client: anthropic.AsyncAnthropic | None = None, sessions: dict | None = None):
        self._client = client
        self._sessions = sessions if sessions is not None else {
            # Two fast sessions: a new guess or command starts at once instead of waiting for an older guess.
            FAST_MODEL: claude_code.Pool([claude_code.Session(FAST_MODEL, CLAUDE_CODE_SYSTEM, thinking=False) for _ in range(2)]),
            STRONG_MODEL: claude_code.Session(STRONG_MODEL, CLAUDE_CODE_SYSTEM),
        }

    @property
    def client(self) -> anthropic.AsyncAnthropic:
        if self._client is None:
            # No retries: the browser waits 20 s for the whole turn, and fast (6 s) plus strong (10 s) already fill it.
            self._client = anthropic.AsyncAnthropic(max_retries=0)
        return self._client

    def reset_client(self) -> None:
        """Build a new client on next use, so a changed API key takes effect."""
        self._client = None

    def warm_up(self) -> None:
        """Start the Claude Code sessions now, so the first command doesn't wait for them."""
        if not has_credentials() and not ollama.fallback.local_only:
            for session in self._sessions.values():
                session.start()

    def can_start_now(self) -> bool:
        """Whether a new request would start straight away rather than queue (always, through the API)."""
        return has_credentials() or getattr(self._sessions.get(FAST_MODEL), "idle", True)

    async def resolve(self, text: str, scene: dict, actions: list[dict], previous: dict | None = None) -> Resolution:
        try:
            async with asyncio.timeout(18):
                return await self._resolve(text, scene, actions, previous)
        except TimeoutError:
            return Resolution({"kind": "error", "reason": "timeout"}, "timeout")

    async def _resolve(self, text: str, scene: dict, actions: list[dict], previous: dict | None = None) -> Resolution:
        quick = grammar.match(text)
        if quick is not None:
            if quick["kind"] == "actions":
                quick["sceneVersion"] = scene.get("version", 0)
            return Resolution(quick, "grammar")

        tools = build_tools(actions)
        user = build_user_message(text, scene, previous)
        attempts: list[dict] = []

        result = await self._attempt(FAST_MODEL, tools, user, scene, actions, attempts)
        if attempts and attempts[-1].get("backend") == "ollama":
            return Resolution(result, "local", attempts)
        # A timeout means the API is slow right now; a second, slower model would only miss the browser's deadline.
        if result["kind"] in ("actions", "none") or result.get("reason") == "timeout":
            return Resolution(result, "fast", attempts)

        strong = await self._attempt(STRONG_MODEL, tools, user, scene, actions, attempts)
        if strong["kind"] != "error":
            return Resolution(strong, "local" if attempts[-1].get("backend") == "ollama" else "strong", attempts)
        # The strong tier failed outright; a clarifying question from the fast tier still beats an error.
        return Resolution(result if result["kind"] == "clarify" else strong, "strong", attempts)

    async def _attempt(self, model: str, tools: list[dict], user: str, scene: dict, actions: list[dict], attempts: list[dict]) -> dict:
        start = time.perf_counter()
        record: dict = {"model": model}
        api = has_credentials()
        async def primary():
            if api:
                response = await self._call(model, tools, user)
                uses = [{"name": b.name, "input": b.input} for b in response.content if b.type == "tool_use"]
                extra = {"backend": "api", "stop_reason": response.stop_reason, "usage": response.usage.model_dump()}
                return uses, extra
            return await self._sessions[model].ask(user, json.dumps(tools), timeout=CLAUDE_CODE_TIMEOUT[model])

        async def local():
            record.update(backend="ollama", local_model=ollama.fallback.model)
            schema = {
                "type": "object", "properties": {"calls": {"type": "array", "minItems": 1, "items": {
                    "oneOf": [{"type": "object", "properties": {"name": {"const": t["name"]}, "input": t["input_schema"]},
                               "required": ["name", "input"], "additionalProperties": False} for t in tools],
                }}}, "required": ["calls"], "additionalProperties": False,
            }
            text = await ollama.fallback.chat(CLAUDE_CODE_SYSTEM, f"<tools>\n{json.dumps(tools)}\n</tools>\n{user}", 1500, schema)
            jsonschema.validate(json.loads(text), schema)
            return claude_code.parse_calls(text), {"backend": "ollama", "local_model": ollama.fallback.model}

        try:
            tool_uses, extra = await ollama.fallback.run(primary, local)
        except (anthropic.APITimeoutError, TimeoutError):
            record.update(error="timeout", ms=_ms(start))
            attempts.append(record)
            return {"kind": "error", "reason": "timeout"}
        except (anthropic.APIStatusError, anthropic.APIConnectionError, claude_code.AnswerError, ClaudeSDKError, ollama.LocalError, jsonschema.ValidationError) as e:
            record.update(error=f"{type(e).__name__}: {e}", ms=_ms(start))
            attempts.append(record)
            return {"kind": "error", "reason": "model_failed"}

        record.update(ms=_ms(start), tool_uses=tool_uses, **extra)
        if extra.get("backend") == "api":
            if extra.get("stop_reason") == "refusal":
                attempts.append(record)
                return {"kind": "error", "reason": "model_failed"}

        result = interpret(tool_uses, scene.get("version", 0))
        if result["kind"] == "actions":
            problems = validate_calls(result["calls"], actions, scene)
            if problems:
                record["problems"] = problems
                attempts.append(record)
                return {"kind": "error", "reason": "invalid_calls", "problems": problems}
        attempts.append(record)
        return result

    async def _call(self, model: str, tools: list[dict], user: str):
        messages = [{"role": "user", "content": user}]
        if model == FAST_MODEL:
            return await self.client.messages.create(
                model=model,
                max_tokens=1024,
                system=SYSTEM,
                tools=tools,
                tool_choice={"type": "any"},
                messages=messages,
                timeout=6,
            )
        # Sonnet 5.5 rejects forced tool_choice, so it runs on auto with the system prompt
        # requiring tool calls; low effort keeps the extra latency to a second or two.
        return await self.client.beta.messages.create(
            model=model,
            max_tokens=4096,
            system=SYSTEM,
            tools=tools,
            tool_choice={"type": "auto"},
            output_config={"effort": "low"},
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
            messages=messages,
            timeout=10,
        )


def _ms(start: float) -> int:
    return round((time.perf_counter() - start) * 1000)
