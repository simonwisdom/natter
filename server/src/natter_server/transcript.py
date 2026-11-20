"""Write out everything said in a Body Lab session, from the sound it recorded.

The Lab records each microphone's sound beside the camera picture (lab-recordings/<session>-mic<N>...webm).
This reads those files after the session, finds the stretches where someone is speaking, and
writes lab-sessions/<session>.transcript.txt: one line per stretch, with its time in the session
and which microphone heard it.

    uv run natter-transcript                 the newest session that has sound
    uv run natter-transcript <session>       one session, for example 2026-11-19T19-02-11

Nothing leaves this computer: the speech model is the one the Lab already uses.
"""

import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

import numpy as np

SAMPLE_RATE = 16000
FRAME = 0.03  # seconds of sound measured at a time
GAP = 0.6  # a pause shorter than this doesn't end a stretch of speech
PAD = 0.2  # sound kept either side of a stretch, so first and last words aren't clipped
SHORTEST = 0.3  # a stretch shorter than this is a click or a cough
LONGEST = 20.0  # the speech model is at its best on short pieces
FLOOR = 0.002  # quieter than this is never speech, however quiet the room

ROOT = Path(__file__).resolve().parents[3]
RECORDINGS = ROOT / "lab-recordings"
SESSIONS = ROOT / "lab-sessions"
SOUND_FILE = re.compile(r"^(?P<session>.+)-mic(?P<mic>\d)(?:c(?P<channel>\d))?-(?P<part>\d+)\.webm$")


def stretches(audio: np.ndarray, rate: int = SAMPLE_RATE) -> list[tuple[float, float]]:
    """The (start, end) seconds of each stretch of speech in `audio`, in order."""
    size = int(rate * FRAME)
    count = len(audio) // size
    if not count:
        return []
    loud = np.sqrt(np.mean(audio[: count * size].reshape(count, size) ** 2, axis=1))
    # The room's own noise is what the quietest fifth of the recording sounds like; speech stands well clear of it.
    # Unless people talked nearly all the way through: then it is set against the loudest parts instead.
    limit = max(min(float(np.percentile(loud, 20)) * 3, float(np.percentile(loud, 95)) * 0.25), FLOOR)
    out: list[list[float]] = []
    for i in np.flatnonzero(loud > limit):
        start, end = i * FRAME, (i + 1) * FRAME
        if out and start - out[-1][1] <= GAP:
            out[-1][1] = end
        else:
            out.append([start, end])
    total = len(audio) / rate
    pieces: list[tuple[float, float]] = []
    for start, end in out:
        if end - start < SHORTEST:
            continue
        start, end = max(0.0, start - PAD), min(total, end + PAD)
        while end - start > LONGEST:
            pieces.append((start, start + LONGEST))
            start += LONGEST
        pieces.append((start, end))
    return pieces


def clock(seconds: float) -> str:
    seconds = max(0, int(seconds))
    return f"{seconds // 60:02d}:{seconds % 60:02d}"


def lines(heard: list[tuple[float, int, str]]) -> str:
    """The transcript's text from (seconds into the session, microphone, words), in time order."""
    return "".join(f"[{clock(at)}] mic {mic}: {words}\n" for at, mic, words in sorted(heard) if words.strip())


def starts(session: str) -> dict[str, float]:
    """When each sound file began, in seconds into the session, from the session's log."""
    out: dict[str, float] = {}
    log = SESSIONS / f"{session}.jsonl"
    if log.exists():
        for line in log.read_text().splitlines():
            if '"soundStart"' not in line:
                continue
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            out[str(event.get("file"))] = float(event.get("t", 0)) / 1000
    return out


def read_sound(path: Path, channel: int | None) -> np.ndarray:
    """One input of a recording as 16 kHz samples."""
    pick = ["-af", f"pan=mono|c0=c{channel}"] if channel is not None else ["-ac", "1"]
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(path), *pick, "-ar", str(SAMPLE_RATE), "-f", "f32le", "-"],
        check=True, capture_output=True,
    ).stdout
    return np.frombuffer(raw, dtype=np.float32)


def newest_session() -> str | None:
    files = sorted((p for p in RECORDINGS.glob("*-mic*.webm") if SOUND_FILE.match(p.name)), key=lambda p: p.stat().st_mtime)
    return SOUND_FILE.match(files[-1].name)["session"] if files else None


def running_server():
    """Speech-to-text through the Natter server if it is running: its speech model is already loaded."""
    url = f"http://127.0.0.1:{os.environ.get('NATTER_PORT') or os.environ.get('GESTURE_ROOM_PORT', '8777')}/transcribe"

    def ask(audio: np.ndarray) -> str:
        request = urllib.request.Request(url, data=audio.astype(np.float32).tobytes(), method="POST")
        with urllib.request.urlopen(request, timeout=120) as answer:
            return str(json.load(answer).get("text", "")).strip()

    try:
        ask(np.zeros(SAMPLE_RATE // 2, dtype=np.float32))
    except (urllib.error.URLError, OSError, ValueError):
        return None
    print("Using the running Natter server's speech model.")
    return ask


def own_model():
    """Speech-to-text with a speech model loaded just for this (a few GB of memory while it runs)."""
    from .stt import Transcriber  # slow to import, and not needed when the server answers

    speech = Transcriber()
    print("The Natter server isn't answering, so loading the speech model here…")
    print(f"Loaded in {speech.load():.0f} s")
    return speech.transcribe


def main() -> None:
    session = sys.argv[1] if len(sys.argv) > 1 else newest_session()
    if not session:
        sys.exit("No session with recorded sound in lab-recordings/. Sound is recorded while the Lab records the camera (V).")
    files = sorted(p for p in RECORDINGS.glob(f"{session}-mic*.webm") if SOUND_FILE.match(p.name))
    if not files:
        sys.exit(f"No recorded sound for {session} in lab-recordings/.")
    to_words = running_server() or own_model()
    began = starts(session)
    heard: list[tuple[float, int, str]] = []
    for path in files:
        found = SOUND_FILE.match(path.name)
        mic = int(found["mic"])
        audio = read_sound(path, int(found["channel"]) if found["channel"] else None)
        offset = began.get(path.stem, 0.0)
        pieces = stretches(audio)
        print(f"{path.name}: {len(audio) / SAMPLE_RATE / 60:.1f} min, {len(pieces)} stretches of speech")
        for start, end in pieces:
            words = to_words(audio[int(start * SAMPLE_RATE) : int(end * SAMPLE_RATE)])
            if words:
                heard.append((offset + start, mic, words))
    out = SESSIONS / f"{session}.transcript.txt"
    out.write_text(lines(heard))
    print(f"Wrote {out} ({len(heard)} lines)")


if __name__ == "__main__":
    main()
