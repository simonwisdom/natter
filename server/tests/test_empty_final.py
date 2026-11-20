"""A loud turn that the speech model returned nothing for is read once more with silence in front."""

import numpy as np

from natter_server import app
from natter_server.stt import SAMPLE_RATE


def _model(monkeypatch, answers):
    """Stand in for the speech model: gives `answers` in turn and records the length of each clip it was given."""
    lengths = []
    replies = iter(answers)

    async def transcribe(audio):
        lengths.append(len(audio))
        return next(replies)

    monkeypatch.setattr(app, "transcribe", transcribe)
    return lengths


async def test_a_loud_turn_that_came_back_empty_is_read_again_with_a_lead_in(monkeypatch):
    lengths = _model(monkeypatch, ["", "Camera."])
    audio = np.full(SAMPLE_RATE * 2, 0.05, dtype=np.float32)
    assert await app.transcribe_final(audio, -32.5) == "Camera."
    assert lengths == [len(audio), len(audio) + int(app.LEAD_IN_S * SAMPLE_RATE)]


async def test_words_on_the_first_pass_are_kept_as_they_are(monkeypatch):
    lengths = _model(monkeypatch, ["Risks."])
    assert await app.transcribe_final(np.full(SAMPLE_RATE, 0.05, dtype=np.float32), -31.0) == "Risks."
    assert len(lengths) == 1


async def test_a_silent_turn_is_not_read_twice(monkeypatch):
    lengths = _model(monkeypatch, [""])
    assert await app.transcribe_final(np.zeros(SAMPLE_RATE, dtype=np.float32), -75.9) == ""
    assert len(lengths) == 1
