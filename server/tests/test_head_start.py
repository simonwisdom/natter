import asyncio

import pytest

from natter_server import app
from natter_server.resolver import Resolution

SCENE = {"version": 3, "objects": []}


class FakeResolver:
    def __init__(self):
        self.texts = []
        self.free = True

    def reset_client(self):
        pass

    def can_start_now(self):
        return self.free

    async def resolve(self, text, scene, actions, previous=None):
        self.texts.append(text)
        await asyncio.sleep(0.01)
        return Resolution({"kind": "actions", "calls": [{"name": "said", "input": {"text": text}}]}, "fast")


class FakeSocket:
    def __init__(self):
        self.sent = []

    async def send_json(self, message):
        self.sent.append(message)


@pytest.fixture
def fake_resolver(monkeypatch, tmp_path):
    fake = FakeResolver()
    monkeypatch.setattr(app, "resolver", fake)
    monkeypatch.setattr(app, "traces", app.TraceLog(tmp_path))
    return fake


async def end_turn(turn, final_text, scene=SCENE, session=None):
    ws, timings = FakeSocket(), {}
    msg = {"turnId": turn.id, "scene": scene, "actions": []}
    await app.finish(ws, final_text, msg, session or {"previous": None}, timings, "p", "gesture", turn.guess)
    return ws.sent[-1], timings


async def test_guess_for_the_same_words_is_used_without_resolving_again(fake_resolver):
    turn = app.Turn("t", "p", "gesture", SCENE, [])
    turn.guess_ahead("Make the fig tree red", None)
    result, timings = await end_turn(turn, "make the fig tree red.")
    assert timings["head_start"] == "used"
    assert fake_resolver.texts == ["Make the fig tree red"]
    assert result["result"]["calls"][0]["input"]["text"] == "Make the fig tree red"


async def test_changed_words_or_board_throw_the_guess_away(fake_resolver):
    turn = app.Turn("t", "p", "gesture", SCENE, [])
    turn.guess_ahead("make the fig tree red", None)
    result, timings = await end_turn(turn, "make the fig tree red, no, blue")
    assert timings["head_start"] == "discarded"
    assert result["result"]["calls"][0]["input"]["text"] == "make the fig tree red, no, blue"

    turn = app.Turn("t2", "p", "gesture", SCENE, [])
    turn.guess_ahead("delete number four", None)
    result, timings = await end_turn(turn, "delete number four", scene={"version": 4, "objects": []})
    assert timings["head_start"] == "discarded"


async def test_newer_words_replace_the_guess_only_when_a_session_is_free(fake_resolver):
    turn = app.Turn("t", "p", "gesture", SCENE, [])
    turn.guess_ahead("make the", None)
    first = turn.guess
    fake_resolver.free = False
    turn.guess_ahead("make the fig tree", None)
    assert turn.guess is first  # would only queue behind the running guess
    fake_resolver.free = True
    turn.guess_ahead("make the fig tree", None)
    assert turn.guess is not first
    await asyncio.sleep(0)
    assert first.task.cancelled()
    await turn.guess.task
