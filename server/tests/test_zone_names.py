import json
from types import SimpleNamespace

import pytest
from fastapi import WebSocketDisconnect

from natter_server import app


@pytest.mark.parametrize("text,ready,fails", [("Weekend ideas", True, False), ("", True, False), ("", False, False), ("", True, True)])
async def test_zone_names_are_transcribed_without_any_model_or_board_action(monkeypatch, text, ready, fails):
    class Socket:
        def __init__(self):
            self.sent = []
            self.messages = iter([
                {"type": "websocket.receive", "text": json.dumps({"type": "turn_start", "turnId": "zone-1", "mode": "zone_name"})},
                {"type": "websocket.receive", "text": json.dumps({"type": "turn_end", "turnId": "zone-1", "mode": "zone_name"})},
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

    async def transcribe(_audio):
        if fails:
            raise RuntimeError("fake failed transcription")
        return text

    async def partial(*_args):
        pass

    def no_model(*_args, **_kwargs):
        pytest.fail("Naming a zone must never call a model or resolve a board command")

    monkeypatch.setattr(app, "status", lambda: {"type": "status"})
    monkeypatch.setattr(app, "transcriber", SimpleNamespace(ready=ready))
    monkeypatch.setattr(app, "transcribe", transcribe)
    monkeypatch.setattr(app, "partial_loop", partial)
    monkeypatch.setattr(app, "finish", no_model)
    monkeypatch.setattr(app, "send_idea", no_model)
    monkeypatch.setattr(app.reworker, "structure", no_model)
    ws = Socket()
    await app.websocket(ws)
    if ready and not fails:
        assert ws.sent[-1] == {"type": "final", "turnId": "zone-1", "audio_s": 0.0, "audio_dbfs": -180.0, "text": text}
    else:
        assert ws.sent[-1]["result"]["kind"] == "error"
    assert ws not in app.sockets
