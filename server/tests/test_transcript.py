import numpy as np

from natter_server import transcript

RATE = transcript.SAMPLE_RATE


def sound(*parts: tuple[float, float]) -> np.ndarray:
    """Seconds of noise at each loudness, end to end."""
    rng = np.random.default_rng(1)
    return np.concatenate([rng.normal(0, level, int(seconds * RATE)).astype(np.float32) for seconds, level in parts])


def test_speech_is_found_between_the_quiet():
    audio = sound((2, 0.001), (1.5, 0.1), (3, 0.001), (2, 0.1), (1, 0.001))
    found = transcript.stretches(audio)
    assert len(found) == 2
    assert abs(found[0][0] - 1.8) < 0.1 and abs(found[0][1] - 3.7) < 0.1
    assert abs(found[1][0] - 6.3) < 0.1 and abs(found[1][1] - 8.7) < 0.1


def test_a_short_pause_does_not_split_a_sentence_and_a_click_is_not_speech():
    audio = sound((1, 0.001), (1, 0.1), (0.4, 0.001), (1, 0.1), (2, 0.001), (0.1, 0.1), (2, 0.001))
    assert len(transcript.stretches(audio)) == 1


def test_a_long_stretch_is_cut_into_pieces_the_speech_model_reads_well():
    found = transcript.stretches(sound((1, 0.001), (45, 0.1), (5, 0.001)))
    assert len(found) == 3 and all(end - start <= transcript.LONGEST + 0.01 for start, end in found)
    assert found[0][1] == found[1][0]


def test_a_silent_recording_has_no_speech():
    assert transcript.stretches(np.zeros(RATE * 5, dtype=np.float32)) == []
    assert transcript.stretches(np.zeros(0, dtype=np.float32)) == []


def test_the_transcript_is_in_time_order_with_the_microphone_named():
    text = transcript.lines([(75.2, 2, "Board games."), (3.0, 1, "Hello."), (80, 1, " ")])
    assert text == "[00:03] mic 1: Hello.\n[01:15] mic 2: Board games.\n"


def test_sound_file_names_say_which_microphone_and_input():
    found = transcript.SOUND_FILE.match("2026-11-19T19-02-11-mic2c1-1.webm")
    assert found["session"] == "2026-11-19T19-02-11" and found["mic"] == "2" and found["channel"] == "1"
    plain = transcript.SOUND_FILE.match("2026-11-19T19-02-11-mic1-3.webm")
    assert plain["mic"] == "1" and plain["channel"] is None
    assert transcript.SOUND_FILE.match("2026-11-19T19-02-11-1.webm") is None
