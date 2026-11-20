from types import SimpleNamespace

import pytest

from natter_server import claude_code, grammar
from natter_server.resolver import FAST_MODEL, STRONG_MODEL, Resolver, interpret, validate_calls

SCENE = {
    "version": 7,
    "objects": [
        {"id": "a", "number": 1, "label": "Lisbon tiles", "colour": "blue"},
        {"id": "b", "number": 2, "label": "Fig tree", "colour": "green"},
    ],
}
ACTIONS = [
    {
        "name": "setColour",
        "description": "Recolour objects.",
        "input_schema": {
            "type": "object",
            "properties": {"ids": {"type": "array", "items": {"type": "string"}, "minItems": 1}, "colour": {"type": "string", "enum": ["blue", "green", "red"]}},
            "required": ["ids", "colour"],
            "additionalProperties": False,
        },
        "risk": "low",
    }
]


@pytest.mark.parametrize("text,name", [("Undo.", "undo"), ("okay undo that please", "undo"), ("Redo", "redo"), ("Yes, do it!", "confirm"), ("no", "reject")])
def test_grammar_actions(text, name):
    assert grammar.match(text)["calls"][0]["name"] == name


def test_grammar_cancel_and_empty():
    assert grammar.match("never mind") == {"kind": "none", "reason": "cancelled"}
    assert grammar.match("  ") == {"kind": "none", "reason": "not_a_command"}
    assert grammar.match("make number one red") is None


def test_validate_rejects_unknown_ids_actions_and_bad_params():
    assert validate_calls([{"name": "setColour", "input": {"ids": ["a"], "colour": "red"}}], ACTIONS, SCENE) == []
    assert "unknown object ids" in validate_calls([{"name": "setColour", "input": {"ids": ["zz"], "colour": "red"}}], ACTIONS, SCENE)[0]
    assert "not an available action" in validate_calls([{"name": "explode", "input": {}}], ACTIONS, SCENE)[0]
    assert validate_calls([{"name": "setColour", "input": {"ids": ["a"], "colour": "mauve"}}], ACTIONS, SCENE)


def test_interpret_distinguishes_clarify_none_and_actions():
    assert interpret([], 1)["kind"] == "error"
    assert interpret([{"name": "clarify", "input": {"question": "Which?"}}], 1)["kind"] == "clarify"
    assert interpret([{"name": "no_action", "input": {"reason": "not_a_command"}}], 1) == {"kind": "none", "reason": "not_a_command", "explanation": ""}
    r = interpret([{"name": "setColour", "input": {"ids": ["a"], "colour": "red"}}], 3)
    assert r["kind"] == "actions" and r["sceneVersion"] == 3


class FakeClient:
    """Returns scripted tool calls per model, so tier escalation can be tested offline."""

    def __init__(self, script):
        self.script = script
        self.calls = []
        self.messages = SimpleNamespace(create=self._create)
        self.beta = SimpleNamespace(messages=SimpleNamespace(create=self._create))

    async def _create(self, model, **kwargs):
        self.calls.append(model)
        uses = self.script[model]
        return SimpleNamespace(
            content=[SimpleNamespace(type="tool_use", name=n, input=i) for n, i in uses],
            stop_reason="tool_use",
            usage=SimpleNamespace(model_dump=lambda: {}),
        )


@pytest.fixture
def with_key(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test")


async def test_fast_tier_answers_when_valid(with_key):
    client = FakeClient({FAST_MODEL: [("setColour", {"ids": ["a"], "colour": "red"})]})
    res = await Resolver(client).resolve("make the tiles red", SCENE, ACTIONS)
    assert res.tier == "fast" and res.result["kind"] == "actions"
    assert client.calls == [FAST_MODEL]


async def test_invalid_fast_calls_escalate_to_strong(with_key):
    client = FakeClient({
        FAST_MODEL: [("setColour", {"ids": ["nope"], "colour": "red"})],
        STRONG_MODEL: [("setColour", {"ids": ["b"], "colour": "red"})],
    })
    res = await Resolver(client).resolve("make the fig red", SCENE, ACTIONS)
    assert res.tier == "strong" and res.result["calls"][0]["input"]["ids"] == ["b"]
    assert client.calls == [FAST_MODEL, STRONG_MODEL]


async def test_clarify_escalates_and_falls_back_to_the_question_if_strong_fails(with_key):
    client = FakeClient({
        FAST_MODEL: [("clarify", {"question": "Which one?"})],
        STRONG_MODEL: [("setColour", {"ids": ["zz"], "colour": "red"})],
    })
    res = await Resolver(client).resolve("that one", SCENE, ACTIONS)
    assert client.calls == [FAST_MODEL, STRONG_MODEL]
    assert res.result["kind"] == "clarify" and res.attempts[1]["problems"]


class FakeSession:
    """Stands in for a Claude Code session: answers each prompt with the next scripted reply."""

    def __init__(self, replies):
        self.replies = list(replies)
        self.prompts = []
        self.tools = []

    async def ask(self, prompt, tools, timeout):
        self.prompts.append(prompt)
        self.tools.append(tools)
        reply = self.replies.pop(0)
        if isinstance(reply, BaseException):
            raise reply
        return claude_code.parse_calls(reply), {"backend": "claude_code"}


@pytest.fixture
def without_key(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("ANTHROPIC_AUTH_TOKEN", raising=False)


async def test_grammar_needs_no_model(without_key):
    res = await Resolver(FakeClient({}), sessions={}).resolve("undo", SCENE, ACTIONS)
    assert res.tier == "grammar" and res.result["sceneVersion"] == 7


async def test_without_key_claude_code_answers_with_json_calls(without_key):
    fast = FakeSession(['```json\n{"calls": [{"name": "setColour", "input": {"ids": ["a"], "colour": "red"}}]}\n```'])
    res = await Resolver(FakeClient({}), sessions={FAST_MODEL: fast, STRONG_MODEL: FakeSession([])}).resolve("make the tiles red", SCENE, ACTIONS)
    assert res.tier == "fast" and res.result["calls"] == [{"name": "setColour", "input": {"ids": ["a"], "colour": "red"}}]
    assert '"name": "setColour"' in fast.tools[0] and "<utterance>make the tiles red</utterance>" in fast.prompts[0]


async def test_without_key_bad_answer_escalates_and_timeout_does_not(without_key):
    strong = FakeSession(['{"calls": [{"name": "setColour", "input": {"ids": ["b"], "colour": "red"}}]}'])
    sessions = {FAST_MODEL: FakeSession(["sorry, no idea"]), STRONG_MODEL: strong}
    res = await Resolver(FakeClient({}), sessions=sessions).resolve("make the fig red", SCENE, ACTIONS)
    assert res.tier == "strong" and res.result["calls"][0]["input"]["ids"] == ["b"]
    assert "AnswerError" in res.attempts[0]["error"]

    sessions = {FAST_MODEL: FakeSession([TimeoutError()]), STRONG_MODEL: FakeSession([])}
    res = await Resolver(FakeClient({}), sessions=sessions).resolve("make the fig red", SCENE, ACTIONS)
    assert res.result == {"kind": "error", "reason": "timeout"}


def test_parse_calls_rejects_answers_without_named_calls():
    assert claude_code.parse_calls('{"calls": [{"name": "undo"}]}') == [{"name": "undo", "input": {}}]
    for bad in ["no json here", '{"calls": "setColour"}', '{"calls": [{"input": {}}]}', "{not json}"]:
        with pytest.raises(claude_code.AnswerError):
            claude_code.parse_calls(bad)
