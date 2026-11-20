import asyncio
import json

import anthropic
import httpx
import pytest

from natter_server import claude_code, ideas, ollama
from natter_server.resolver import FAST_MODEL, STRONG_MODEL, Resolver
from test_resolver import ACTIONS, SCENE, FakeSession


@pytest.fixture
def standby(monkeypatch):
    monkeypatch.setenv("NATTER_OLLAMA_MODEL", "test-local")
    fallback = ollama.Fallback()
    monkeypatch.setattr(ollama, "fallback", fallback)
    return fallback


async def test_failure_routes_locally_until_cooldown_then_recovers(
    standby, monkeypatch
):
    now = [100.0]
    monkeypatch.setattr(ollama.time, "monotonic", lambda: now[0])
    calls = []

    async def broken():
        calls.append("claude")
        raise TimeoutError()

    async def local():
        calls.append("local")
        return "local answer"

    assert await standby.run(broken, local) == "local answer"
    assert await standby.run(broken, local) == "local answer"
    assert calls == ["claude", "local", "local"]
    now[0] += 61

    async def recovered():
        return "claude answer"

    assert await standby.run(recovered, local) == "claude answer"
    assert not standby.active and standby.retry_at == 0


@pytest.mark.parametrize(
    "code,falls_back",
    [(429, True), (503, True), (400, False), (401, False), (403, False)],
)
async def test_only_availability_errors_switch_provider(standby, code, falls_back):
    async def primary():
        response = httpx.Response(
            code, request=httpx.Request("POST", "https://example.test")
        )
        raise anthropic.APIStatusError("failed", response=response, body={})

    async def local():
        return "local"

    if falls_back:
        assert await standby.run(primary, local) == "local"
    else:
        with pytest.raises(anthropic.APIStatusError):
            await standby.run(primary, local)
        assert not standby.active


async def test_recovery_probe_is_single_and_failed_local_is_never_success(
    standby, monkeypatch
):
    standby.retry_at = 1
    entered, release = asyncio.Event(), asyncio.Event()
    calls = []

    async def primary():
        calls.append("probe")
        entered.set()
        await release.wait()
        return "claude"

    async def local():
        raise ollama.LocalError("stopped")

    task = asyncio.create_task(standby.run(primary, local))
    try:
        await asyncio.wait_for(entered.wait(), 10)
        with pytest.raises(ollama.LocalError):
            await standby.run(primary, local)
        assert calls == ["probe"]
    finally:
        release.set()
        assert await task == "claude"
    assert standby.retry_at == 0 and not standby._probe


async def test_cancelled_probe_releases_ownership(standby):
    standby.retry_at = 1
    entered = asyncio.Event()

    async def primary():
        entered.set()
        await asyncio.Event().wait()

    task = asyncio.create_task(standby.run(primary, primary))
    await asyncio.wait_for(entered.wait(), 10)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert not standby._probe


@pytest.mark.parametrize(
    "body",
    [
        [],
        {"done": False, "message": {"content": "{}"}},
        {"done": True, "done_reason": "length", "message": {"content": "{}"}},
        {"done": True, "message": {"content": "[]"}},
        {"done": True, "message": {"content": "not json"}},
        {"done": True},
    ],
)
async def test_http_answers_must_be_complete_json_objects(standby, monkeypatch, body):
    factory = httpx.AsyncClient
    transport = httpx.MockTransport(lambda request: httpx.Response(200, json=body))
    monkeypatch.setattr(
        ollama.httpx,
        "AsyncClient",
        lambda **kwargs: factory(transport=transport, **kwargs),
    )
    with pytest.raises(ollama.LocalError):
        await standby.chat("system", "prompt", 200)


async def test_local_http_is_loopback_stateless_bounded_and_not_cloud(
    standby, monkeypatch
):
    requests = []

    def handle(request):
        requests.append(request)
        return httpx.Response(
            200, json={"done": True, "message": {"content": '{"text":"Park"}'}}
        )

    factory = httpx.AsyncClient
    monkeypatch.setattr(
        ollama.httpx,
        "AsyncClient",
        lambda **kwargs: factory(transport=httpx.MockTransport(handle), **kwargs),
    )
    for prompt in ("zone A", "zone B"):
        assert await standby.chat("system", prompt, 200) == '{"text":"Park"}'
    assert str(requests[0].url) == "http://127.0.0.1:11434/api/chat"
    payload = json.loads(requests[1].content)
    assert payload["messages"] == [
        {"role": "system", "content": "system"},
        {"role": "user", "content": "zone B"},
    ]
    assert payload["options"]["num_predict"] == 200
    assert payload["think"] is False and payload["keep_alive"] == "1m"


async def test_local_connection_failure_is_reported(standby, monkeypatch):
    def handle(request):
        raise httpx.ConnectError("stopped", request=request)

    factory = httpx.AsyncClient
    monkeypatch.setattr(
        ollama.httpx,
        "AsyncClient",
        lambda **kwargs: factory(transport=httpx.MockTransport(handle), **kwargs),
    )
    with pytest.raises(ollama.LocalError):
        await standby.chat("system", "prompt", 200)


async def test_idea_fallback_preserves_zone_and_existing_parser(standby, monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("ANTHROPIC_AUTH_TOKEN", raising=False)
    prompts = []

    class Broken:
        async def ask_text(self, *args):
            raise claude_code.AnswerError("down")

    async def chat(system, prompt, max_tokens, schema):
        prompts.append(prompt)
        return '{"text":"Nearby park","emoji":"🌳"}'

    monkeypatch.setattr(standby, "chat", chat)
    answer = await ideas.Reworker(session=Broken()).rework(
        "further", "Walk", zone="Nearby", board=["Park"]
    )
    assert answer["text"] == "Nearby park"
    assert "<zone>Nearby</zone>" in prompts[0] and "- Park" in prompts[0]


@pytest.mark.parametrize(
    "calls,kind",
    [
        ([{"name": "setColour", "input": {"ids": ["a"], "colour": "red"}}], "actions"),
        (
            [{"name": "setColour", "input": {"ids": ["ghost"], "colour": "red"}}],
            "error",
        ),
        ([{"name": "setColour", "input": {"ids": ["a"], "colour": "mauve"}}], "error"),
        ([{"name": "explode", "input": {}}], "error"),
        ([{"name": "clarify", "input": {"question": "Which one?"}}], "clarify"),
    ],
)
async def test_resolver_local_calls_use_same_validation_and_do_not_retry_down_claude(
    standby, monkeypatch, calls, kind
):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("ANTHROPIC_AUTH_TOKEN", raising=False)

    async def chat(*args):
        return json.dumps({"calls": calls})

    monkeypatch.setattr(standby, "chat", chat)
    strong = FakeSession([])
    resolver = Resolver(
        sessions={FAST_MODEL: FakeSession([TimeoutError()]), STRONG_MODEL: strong}
    )
    answer = await resolver.resolve("make the tiles red", SCENE, ACTIONS)
    assert answer.tier == "local" and answer.result["kind"] == kind
    assert answer.attempts[0]["backend"] == "ollama" and not strong.prompts


async def test_disabled_fallback_leaves_existing_route_untouched(monkeypatch):
    async def primary():
        raise TimeoutError()

    async def local():
        pytest.fail("disabled fallback ran")

    with pytest.raises(TimeoutError):
        await ollama.Fallback().run(primary, local)


async def test_slow_claude_leaves_time_for_local_and_cancels_late_answer(
    standby, monkeypatch
):
    monkeypatch.setattr(ollama, "PRIMARY_TIMEOUT", 0.01)
    cancelled = asyncio.Event()

    async def primary():
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()

    async def local():
        return "local"

    assert await standby.run(primary, local) == "local"
    assert cancelled.is_set() and standby.active


async def test_healthy_concurrent_requests_stay_on_claude(standby):
    entered, release = asyncio.Event(), asyncio.Event()

    async def first():
        entered.set()
        await release.wait()
        return "first"

    async def second():
        return "second"

    async def local():
        pytest.fail("Healthy parallel request went to Ollama")

    task = asyncio.create_task(standby.run(first, local))
    try:
        await asyncio.wait_for(entered.wait(), 10)
        assert await standby.run(second, local) == "second"
    finally:
        release.set()
        assert await task == "first"


async def test_local_queue_timeout_leaves_no_stale_work(standby, monkeypatch):
    monkeypatch.setattr(ollama, "LOCAL_TIMEOUT", 0.01)
    await standby._local_lock.acquire()
    try:
        with pytest.raises(TimeoutError):
            await standby.chat("system", "prompt", 200)
    finally:
        standby._local_lock.release()
    assert not standby._local_lock.locked()


async def test_suggestions_drop_existing_labels_and_repeated_new_labels(
    standby, monkeypatch
):
    standby.retry_at = ollama.time.monotonic() + 60
    answer = (
        '{"ideas":[{"text":"Shared garden"},{"text":"Seed swap"},{"text":"Seed swap"}]}'
    )

    async def chat(*args):
        return answer

    monkeypatch.setattr(standby, "chat", chat)
    worker = ideas.Reworker()
    result = await worker.suggest("Shared garden", [], ["Tool library"])
    assert result["ideas"] == [{"text": "Seed swap", "emoji": ""}]
    answer = '{"ideas":[{"text":"SHARED GARDEN"},{"text":"Tool library"}]}'
    with pytest.raises(ideas.IdeaError, match="repeated"):
        await worker.suggest("Shared garden", [], ["Tool library"])


async def test_sdk_process_failure_also_uses_local(standby):
    from claude_agent_sdk import ProcessError

    async def primary():
        raise ProcessError("CLI connection failed")

    async def local():
        return "local"

    assert await standby.run(primary, local) == "local"


@pytest.mark.parametrize("fails", [False, True])
async def test_app_sends_local_status_then_result_or_error_and_traces_backend(
    standby, monkeypatch, tmp_path, fails
):
    from natter_server import app

    monkeypatch.setattr(app, "ROOT", tmp_path)
    monkeypatch.setattr(app, "traces", app.TraceLog(tmp_path / "traces"))
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("ANTHROPIC_AUTH_TOKEN", raising=False)

    async def down(*args):
        raise claude_code.AnswerError("Claude down")

    async def local(*args):
        if fails:
            raise ollama.LocalError("Ollama stopped")
        return '{"text":"Seed swap","emoji":"🌱"}'

    monkeypatch.setattr(app.reworker, "_ask_claude", down)
    monkeypatch.setattr(standby, "chat", local)

    class Socket:
        sent = []

        async def send_json(self, message):
            self.sent.append(message)

    ws = Socket()
    await app.send_idea(ws, "b1", "further", "Garden")
    assert ws.sent[0]["llm"] == ("ollama_failed" if fails else "ollama")
    assert ws.sent[-1]["type"] == "idea" and ws.sent[-1]["id"] == "b1"
    if fails:
        assert ws.sent[-1]["error"] == "model_failed" and "text" not in ws.sent[-1]
    else:
        assert ws.sent[-1]["text"] == "Seed swap" and ws.sent[-1]["backend"] == "ollama"


@pytest.fixture
def local_only(monkeypatch):
    monkeypatch.setenv("NATTER_LLM", "local")
    monkeypatch.delenv("NATTER_OLLAMA_MODEL", raising=False)
    fallback = ollama.Fallback()
    monkeypatch.setattr(ollama, "fallback", fallback)
    return fallback


async def test_local_only_never_tries_claude(local_only):
    async def primary():
        pytest.fail("Claude was tried in local-only mode")

    async def local():
        return "local"

    assert await local_only.run(primary, local) == "local"
    assert local_only.active and local_only.model == "qwen3:8b"


async def test_local_only_keeps_a_model_when_standby_is_switched_off(local_only, monkeypatch):
    monkeypatch.setenv("NATTER_OLLAMA_MODEL", "")
    assert local_only.model == "qwen3:8b"
    monkeypatch.setenv("NATTER_OLLAMA_MODEL", "llama3.2")
    assert local_only.model == "llama3.2"


async def test_local_only_failure_is_an_error_not_claude(local_only):
    async def primary():
        pytest.fail("Claude was tried in local-only mode")

    async def local():
        raise ollama.LocalError("down")

    with pytest.raises(ollama.LocalError):
        await local_only.run(primary, local)
    assert local_only.local_ready is False


async def test_local_only_ideas_and_commands_use_ollama_and_start_no_session(local_only, monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("ANTHROPIC_AUTH_TOKEN", raising=False)

    class NoSession:
        def start(self):
            pytest.fail("a Claude Code session was started in local-only mode")

        async def ask_text(self, *args):
            pytest.fail("Claude Code was asked in local-only mode")

    async def chat(system, prompt, max_tokens, schema="json"):
        if "<tools>" in prompt:
            return json.dumps({"calls": [{"name": "setColour", "input": {"ids": ["a"], "colour": "red"}}]})
        return '{"text":"Park","emoji":"🌳"}'

    monkeypatch.setattr(local_only, "chat", chat)
    reworker = ideas.Reworker(session=NoSession())
    reworker.warm_up()
    answer = await reworker.rework("name", heard="a park")
    assert answer["text"] == "Park" and answer["backend"] == "ollama"

    resolver = Resolver(sessions={FAST_MODEL: NoSession(), STRONG_MODEL: NoSession()})
    resolver.warm_up()
    res = await resolver.resolve("make the tiles red", SCENE, ACTIONS)
    assert res.tier == "local" and res.result["kind"] == "actions"
