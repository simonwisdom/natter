import pytest

from natter_server.app import is_filler


@pytest.mark.parametrize("text", ["Well,", "Mm-hmm.", "Whoa.", "Oh.", "Yeah.", "Um, well", "Oh, okay.", "uh huh"])
def test_a_few_filler_words_alone_are_not_an_idea(text):
    assert is_filler(text)


@pytest.mark.parametrize("text", ["", "   ", "Philosophy.", "Well water", "Oh, the weekend market", "Conflicts", "No dig gardening", "Well, well, well, well"])
def test_real_words_longer_runs_and_silence_are_left_alone(text):
    assert not is_filler(text)


@pytest.mark.parametrize("mode", ["idea", "structure"])
@pytest.mark.parametrize("text,skipped", [("Mm-hmm.", True), ("Weekly salons.", False)])
async def test_a_filler_turn_reaches_the_lab_as_nothing_said_and_never_reaches_a_model(monkeypatch, mode, text, skipped):
    import json
    from types import SimpleNamespace

    from fastapi import WebSocketDisconnect

    from natter_server import app

    class Socket:
        def __init__(self):
            self.sent = []
            self.messages = iter([
                {"type": "websocket.receive", "text": json.dumps({"type": "turn_start", "turnId": "t1", "mode": mode})},
                {"type": "websocket.receive", "text": json.dumps({"type": "turn_end", "turnId": "t1", "mode": mode, "board": [{"id": "b1", "text": "x"}]})},
                {"type": "websocket.disconnect"},
            ])

        async def accept(self):
            pass

        async def receive(self):
            try:
                return next(self.messages)
            except StopIteration:
                raise WebSocketDisconnect()

        async def send_json(self, message):
            self.sent.append(message)

    asked = []

    async def transcribe(_audio):
        return text

    async def partial(*_args):
        pass

    def spawn(coro):
        asked.append(coro)
        coro.close()

    monkeypatch.setattr(app, "status", lambda: {"type": "status"})
    monkeypatch.setattr(app, "transcriber", SimpleNamespace(ready=True))
    monkeypatch.setattr(app, "transcribe", transcribe)
    monkeypatch.setattr(app, "partial_loop", partial)
    monkeypatch.setattr(app, "spawn", spawn)
    ws = Socket()
    await app.websocket(ws)
    final = [m for m in ws.sent if m.get("type") == "final"][-1]
    if skipped:
        assert final == {"type": "final", "turnId": "t1", "audio_s": 0.0, "audio_dbfs": -180.0, "text": "", "skipped": "Mm-hmm."}
        assert not asked
    else:
        assert final == {"type": "final", "turnId": "t1", "audio_s": 0.0, "audio_dbfs": -180.0, "text": text}
        assert len(asked) == 1


@pytest.mark.parametrize("text,heard", [("Similarities.", "Similarities."), ("Um.", ""), ("", "")])
async def test_an_angle_turn_only_sends_the_words_back_with_how_loud_it_was_and_a_noise_is_no_angle(monkeypatch, text, heard):
    import json

    import numpy as np
    from types import SimpleNamespace

    from fastapi import WebSocketDisconnect

    from natter_server import app

    class Socket:
        def __init__(self):
            self.sent = []
            self.messages = iter([
                {"type": "websocket.receive", "text": json.dumps({"type": "turn_start", "turnId": "a1", "mode": "angle"})},
                {"type": "websocket.receive", "bytes": np.full(8000, 0.1, dtype=np.float32).tobytes()},  # half a second at -20 dBFS
                {"type": "websocket.receive", "text": json.dumps({"type": "turn_end", "turnId": "a1", "mode": "angle"})},
                {"type": "websocket.receive", "text": json.dumps({"type": "suggest", "id": "b9,b10", "idea": "Long walk", "other": "Read in the park", "angle": heard, "branches": [], "board": ["Sleep in"]})},
                {"type": "websocket.disconnect"},
            ])

        async def accept(self):
            pass

        async def receive(self):
            try:
                return next(self.messages)
            except StopIteration:
                raise WebSocketDisconnect()

        async def send_json(self, message):
            self.sent.append(message)

    spawned, suggested = [], []

    async def transcribe(_audio):
        return text

    async def partial(*_args):
        pass

    def spawn(coro):
        spawned.append(coro)
        coro.close()

    def record(*args):
        suggested.append(args)  # send_lab would await this; spawn closes it first

    monkeypatch.setattr(app, "status", lambda: {"type": "status"})
    monkeypatch.setattr(app, "transcriber", SimpleNamespace(ready=True))
    monkeypatch.setattr(app, "transcribe", transcribe)
    monkeypatch.setattr(app, "partial_loop", partial)
    monkeypatch.setattr(app, "spawn", spawn)
    monkeypatch.setattr(app.reworker, "suggest", record)
    ws = Socket()
    await app.websocket(ws)
    assert [m for m in ws.sent if m.get("type") in ("final", "result", "idea")] == [{"type": "final", "turnId": "a1", "audio_s": 0.5, "audio_dbfs": -20.0, "text": heard}]
    assert len(spawned) == 1  # only the suggest reached a model; the angle turn itself did not
    assert suggested == [("Long walk", [], ["Sleep in"], None, "Read in the park", heard, [])]  # the last is a hub's linked ideas: none here
