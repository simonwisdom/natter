import json
from pathlib import Path

import pytest
from fastapi import HTTPException

from natter_server import replay


def write_log(folder: Path, name: str, events: list[dict], pad: bool = True) -> None:
    folder.mkdir(exist_ok=True)
    lines = [json.dumps(e) for e in events]
    if pad:
        lines += [json.dumps({"t": 9000 + i, "type": "stats", "fps": 30}) for i in range(80)]
    (folder / f"{name}.jsonl").write_text("\n".join(lines) + "\n")


@pytest.fixture
def folders(tmp_path, monkeypatch):
    monkeypatch.setattr(replay, "SESSIONS", tmp_path / "sessions")
    monkeypatch.setattr(replay, "RECORDINGS", tmp_path / "rec")
    monkeypatch.setattr(replay, "CACHE", tmp_path / "cache")
    (tmp_path / "sessions").mkdir()
    (tmp_path / "rec").mkdir()
    return tmp_path


def test_sessions_are_listed_newest_first_without_the_empty_ones(folders):
    write_log(folders / "sessions", "2026-11-17T10-00-00", [{"t": 1, "type": "start"}])
    write_log(folders / "sessions", "2026-11-18T10-00-00", [{"t": 1, "type": "start"}])
    write_log(folders / "sessions", "2026-11-18T11-00-00", [{"t": 1, "type": "start"}], pad=False)
    (folders / "rec" / "2026-11-18T10-00-00-1.webm").write_bytes(b"v")
    (folders / "rec" / "2026-11-17T10-00-00-mic1-1.webm").write_bytes(b"a")  # sound alone is not a recording to watch
    listed = replay.sessions()
    assert [s["id"] for s in listed] == ["2026-11-18T10-00-00", "2026-11-17T10-00-00"]
    assert [s["recorded"] for s in listed] == [True, False]


def test_a_session_gives_its_events_and_pairs_each_recording_with_its_sound(folders):
    events = [
        {"t": 1, "type": "start"},
        {"t": 1854, "type": "recordStart", "file": "s-1"},
        {"t": 2851, "type": "soundStart", "file": "s-mic1-1", "mic": 1},
        {"t": 2900, "type": "soundStart", "file": "s-mic2-1", "mic": 2},
        {"t": 30000, "type": "screenStart", "file": "s-screen-1"},
        {"t": 50000, "type": "soundStop", "file": "s-mic2-1", "mic": 2},
        {"t": 60000, "type": "recordStart", "file": "s-2"},
        {"t": 60100, "type": "soundStart", "file": "s-mic1-2", "mic": 1},
        {"t": 90000, "type": "recordStart", "file": "s-3"},  # this file was pruned
    ]
    write_log(folders / "sessions", "s", events)
    (folders / "sessions" / "s.jsonl").open("a").write('{"t": 5, "type": "cut sho')
    for name in ("s-1", "s-2", "s-screen-1"):
        (folders / "rec" / f"{name}.webm").write_bytes(b"v")
    got = replay.session("s")
    assert len(got["events"]) == len(events) + 80
    # The second microphone had stopped before the second recording began, so only the first goes with it.
    assert got["segments"] == [
        {"file": "s-1", "t": 1854, "sound": [{"file": "s-mic1-1", "mic": 1, "after_s": 0.997}, {"file": "s-mic2-1", "mic": 2, "after_s": 1.046}]},
        {"file": "s-2", "t": 60000, "sound": [{"file": "s-mic1-2", "mic": 1, "after_s": 0.1}]},
    ]
    # The screen started part-way through the sound, so each microphone is entered that far in.
    assert got["screens"] == [
        {"file": "s-screen-1", "t": 30000, "sound": [{"file": "s-mic1-1", "mic": 1, "after_s": -27.149}, {"file": "s-mic2-1", "mic": 2, "after_s": -27.1}]},
    ]


def test_a_missing_session_or_a_name_that_climbs_out_is_not_found(folders):
    (folders / "secret.jsonl").write_text('{"t": 1, "type": "start"}\n')
    for name in ("nope", "../secret", ""):
        with pytest.raises(HTTPException) as err:
            replay.session(name)
        assert err.value.status_code == 404


def test_the_join_lays_each_microphone_under_the_picture_at_its_own_start():
    v, a, b, out = Path("v.webm"), Path("a.webm"), Path("b.webm"), Path("out.webm")
    assert replay.join_command(v, [], out) == ["ffmpeg", "-v", "error", "-y", "-i", "v.webm", "-an", "-c:v", "copy", "out.webm"]
    one = replay.join_command(v, [(a, 0.997)], out)
    assert one[6:] == ["-itsoffset", "0.997", "-i", "a.webm", "-map", "0:v", "-map", "1:a", "-c", "copy", "out.webm"]
    running = replay.join_command(v, [(a, -27.149)], out)
    assert running[6:10] == ["-ss", "27.149", "-i", "a.webm"]
    two = replay.join_command(v, [(a, 0.997), (b, 1.046)], out)
    assert "[1:a][2:a]amix=inputs=2:normalize=0[a]" in two and two[-5:] == ["-c:v", "copy", "-c:a", "libopus", "out.webm"]


def test_the_joined_copy_is_reused_until_a_recording_changes_and_survives_unreadable_sound(folders, monkeypatch):
    import os

    runs = []

    def fake_run(cmd, **_):
        runs.append(cmd)
        failed = "bad.webm" in " ".join(cmd)
        if not failed:
            Path(cmd[-1]).write_bytes(b"joined")
        return type("Done", (), {"returncode": 1 if failed else 0, "stderr": "bad sound"})()

    monkeypatch.setattr(replay.shutil, "which", lambda _: "/usr/bin/ffmpeg")
    monkeypatch.setattr(replay.subprocess, "run", fake_run)
    rec = folders / "rec"
    (rec / "s-1.webm").write_bytes(b"v")
    (rec / "s-mic1-1.webm").write_bytes(b"a")
    seg = {"file": "s-1", "t": 0, "sound": [{"file": "s-mic1-1", "mic": 1, "after_s": 1.0}, {"file": "gone", "mic": 2, "after_s": 1.0}]}
    out = replay.joined(seg)
    assert out == folders / "cache" / "s-1.webm" and out.read_bytes() == b"joined"
    assert len(runs) == 1 and "gone" not in " ".join(runs[0])
    replay.joined(seg)
    assert len(runs) == 1
    later = out.stat().st_mtime + 10
    os.utime(rec / "s-1.webm", (later, later))
    replay.joined(seg)
    assert len(runs) == 2

    (rec / "bad.webm").write_bytes(b"x")
    os.utime(rec / "bad.webm", (later + 10, later + 10))
    replay.joined({"file": "s-1", "t": 0, "sound": [{"file": "bad", "mic": 1, "after_s": 0}]})
    assert "-an" in runs[-1] and "bad.webm" in " ".join(runs[-2])


def test_without_ffmpeg_the_recording_itself_is_served(folders, monkeypatch):
    monkeypatch.setattr(replay.shutil, "which", lambda _: None)
    (folders / "rec" / "s-1.webm").write_bytes(b"v")
    assert replay.joined({"file": "s-1", "t": 0, "sound": []}) == folders / "rec" / "s-1.webm"
