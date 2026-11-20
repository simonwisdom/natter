import asyncio

import pytest

from natter_server import claude_code
from claude_agent_sdk import ResultMessage

ANSWER = '{"calls": [{"name": "undo", "input": {}}]}'


class FakeClient:
    """Stands in for ClaudeSDKClient: records prompts and answers each after `delay` seconds."""

    prompts: list[str] = []
    delay = 0.0

    def __init__(self, options):
        pass

    async def connect(self):
        pass

    async def disconnect(self):
        pass

    async def query(self, prompt):
        FakeClient.prompts.append(prompt)

    async def receive_response(self):
        await asyncio.sleep(FakeClient.delay)
        yield ResultMessage(subtype="success", duration_ms=1, duration_api_ms=1, is_error=False, num_turns=1, session_id="s", result=ANSWER)


@pytest.fixture
def fake_client(monkeypatch):
    FakeClient.prompts = []
    FakeClient.delay = 0.0
    monkeypatch.setattr(claude_code, "ClaudeSDKClient", FakeClient)
    monkeypatch.setattr(claude_code.Session, "_exchange", _exchange_text_from_result)


async def _exchange_text_from_result(self, client, prompt):
    await client.query(prompt)
    async for message in client.receive_response():
        return message.result, {}


async def test_tools_are_sent_once_per_session_and_again_when_they_change(fake_client):
    session = claude_code.Session("m", "system")
    await session.ask("one", "TOOLS-A", timeout=1)
    await session.ask("two", "TOOLS-A", timeout=1)
    await session.ask("three", "TOOLS-B", timeout=1)
    assert ["<tools>" in p for p in FakeClient.prompts] == [True, False, True]
    assert "TOOLS-B" in FakeClient.prompts[2]


async def test_single_request_sessions_get_fresh_clients(fake_client, monkeypatch):
    clients = []

    class RecordingClient(FakeClient):
        def __init__(self, options):
            clients.append(self)

        async def query(self, prompt):
            self.prompt = prompt

    monkeypatch.setattr(claude_code, "ClaudeSDKClient", RecordingClient)
    session = claude_code.Session("m", "system", recycle_after=1)
    try:
        await session.ask_text("zone one", None, timeout=1)
        await session.ask_text("zone two", None, timeout=1)
        assert clients[0] is not clients[1]
        assert clients[0].prompt == "zone one"
        assert clients[1].prompt == "zone two"
    finally:
        session._worker.cancel()
        with pytest.raises(asyncio.CancelledError):
            await session._worker


async def test_pool_sends_a_new_request_to_a_free_session(fake_client):
    pool = claude_code.Pool([claude_code.Session("m", "system") for _ in range(2)])
    assert pool.idle
    FakeClient.delay = 0.2
    busy = asyncio.create_task(pool.ask("slow guess", "T", timeout=1))
    await asyncio.sleep(0.05)
    assert pool.idle  # the second session is still free
    FakeClient.delay = 0.0
    await pool.ask("command", "T", timeout=1)
    assert not busy.done()  # the command didn't wait for the guess
    await busy


async def test_a_request_whose_caller_gave_up_is_skipped(fake_client):
    session = claude_code.Session("m", "system")
    FakeClient.delay = 0.2
    first = asyncio.create_task(session.ask("busy", "T", timeout=1))
    await asyncio.sleep(0.05)
    abandoned = asyncio.create_task(session.ask("abandoned", "T", timeout=1))
    await asyncio.sleep(0.01)
    abandoned.cancel()
    FakeClient.delay = 0.0
    await first
    await session.ask("next", "T", timeout=1)
    assert [p.split("\n")[-1] for p in FakeClient.prompts] == ["busy", "next"]
