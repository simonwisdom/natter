"""The replay viewer's side of the server (web/replay.html): the Body Lab sessions on this computer,
one session's log, and its recordings (the camera's, and the screen's when that was recorded too)
joined with the microphones' sound.

A recording made in the browser has no length or index, so it can't be jumped around in, and each
microphone's sound is a file of its own. ffmpeg copies the picture into a new file with both, and
lays the sound under it at the moment the log says it started. The copy is kept in the temporary
folder and made again when a recording changes.
"""

import asyncio
import json
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

ROOT = Path(__file__).resolve().parents[3]
SESSIONS = ROOT / "lab-sessions"
RECORDINGS = ROOT / "lab-recordings"
CACHE = Path(tempfile.gettempdir()) / "natter-replay"

router = APIRouter(prefix="/lab-replay")
_joining = asyncio.Lock()


def safe(name: str) -> str:
    return re.sub(r"[^0-9A-Za-z_-]", "", name)[:60]


def read_events(session: str) -> list[dict]:
    path = SESSIONS / f"{safe(session)}.jsonl"
    if not safe(session) or not path.exists():
        raise HTTPException(status_code=404, detail="no such session")
    events = []
    for line in path.read_text().splitlines():
        try:
            event = json.loads(line)
        except ValueError:
            continue  # a line cut short when the page closed
        if isinstance(event, dict) and isinstance(event.get("t"), (int, float)):
            events.append(event)
    return events


def segments(events: list[dict], start: str = "recordStart") -> list[dict]:
    """Each stretch of recording in a session (the camera's, or with start="screenStart" the screen's):
    its file, when it started (ms into the session), and the sound that goes with it, each file with
    how long after the picture it started (negative when the sound was already running)."""
    out = []
    for e in events:
        if e.get("type") == start and isinstance(e.get("file"), str):
            out.append({"file": safe(e["file"]), "t": e["t"], "sound": []})
    starts = [e for e in events if e.get("type") == "soundStart" and isinstance(e.get("file"), str)]
    stopped = {e.get("file"): e["t"] for e in events if e.get("type") == "soundStop"}
    for seg in out:
        for mic in sorted({e.get("mic") for e in starts}, key=str):
            mine = [e for e in starts if e.get("mic") == mic]
            # The file that was running when the picture started (sound starts about a second after
            # the camera, so a little later still counts), or failing that the first one after it.
            running = [e for e in mine if e["t"] <= seg["t"] + 2000 and stopped.get(e["file"], float("inf")) > seg["t"]]
            later = [e for e in mine if e["t"] > seg["t"] + 2000]
            e = running[-1] if running else later[0] if later else None
            if e:
                seg["sound"].append({"file": safe(e["file"]), "mic": mic, "after_s": round((e["t"] - seg["t"]) / 1000, 3)})
    return [s for s in out if (RECORDINGS / f"{s['file']}.webm").exists()]


def join_command(video: Path, sound: list[tuple[Path, float]], out: Path) -> list[str]:
    cmd = ["ffmpeg", "-v", "error", "-y", "-i", str(video)]
    for path, after_s in sound:
        # Sound that began after the picture is laid in late; sound already running is entered part-way through.
        cmd += ["-itsoffset", f"{after_s:.3f}"] if after_s >= 0 else ["-ss", f"{-after_s:.3f}"]
        cmd += ["-i", str(path)]
    if len(sound) > 1:
        mix = "".join(f"[{i + 1}:a]" for i in range(len(sound))) + f"amix=inputs={len(sound)}:normalize=0[a]"
        cmd += ["-filter_complex", mix, "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "libopus"]
    elif sound:
        cmd += ["-map", "0:v", "-map", "1:a", "-c", "copy"]
    else:
        cmd += ["-an", "-c:v", "copy"]
    return [*cmd, str(out)]


def joined(seg: dict) -> Path:
    """The seekable copy of one recording with its sound, made if it is missing or out of date."""
    video = RECORDINGS / f"{seg['file']}.webm"
    sound = [(RECORDINGS / f"{s['file']}.webm", s["after_s"]) for s in seg["sound"]]
    sound = [(p, after) for p, after in sound if p.exists()]
    if not shutil.which("ffmpeg"):
        return video  # plays, without sound, and can't be jumped around in
    out = CACHE / f"{seg['file']}.webm"
    newest = max(p.stat().st_mtime for p in [video, *(p for p, _ in sound)])
    if out.exists() and out.stat().st_mtime >= newest:
        return out
    CACHE.mkdir(exist_ok=True)
    part = out.with_suffix(".part.webm")
    done = subprocess.run(join_command(video, sound, part), capture_output=True, text=True)
    if done.returncode != 0 and sound:
        # Sound that can't be read mustn't take the picture with it.
        done = subprocess.run(join_command(video, [], part), capture_output=True, text=True)
    if done.returncode != 0:
        raise HTTPException(status_code=500, detail=f"could not prepare the recording: {done.stderr.strip()[:200]}")
    part.replace(out)
    return out


@router.get("/sessions")
def sessions() -> list[dict]:
    """Newest first. A session with nothing done in it (a page opened and closed) is left out."""
    out = []
    for path in sorted(SESSIONS.glob("*.jsonl"), reverse=True):
        size = path.stat().st_size
        if size < 2000:
            continue
        recorded = any(RECORDINGS.glob(f"{path.stem}-[0-9]*.webm"))
        out.append({"id": path.stem, "kb": round(size / 1000), "recorded": recorded})
    return out


@router.get("/sessions/{session}")
def session(session: str) -> dict:
    events = read_events(session)
    return {"id": safe(session), "events": events, "segments": segments(events), "screens": segments(events, "screenStart")}


@router.get("/media/{session}/{index}")
async def media(session: str, index: int, view: str = "camera") -> FileResponse:
    segs = segments(read_events(session), "screenStart" if view == "screen" else "recordStart")
    if not 0 <= index < len(segs):
        raise HTTPException(status_code=404, detail="no such recording")
    async with _joining:
        path = await asyncio.to_thread(joined, segs[index])
    return FileResponse(path, media_type="video/webm")
