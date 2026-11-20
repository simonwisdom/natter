"""Local server: speech-to-text and the intent resolver over one WebSocket.

Protocol (JSON text frames unless noted):
  browser -> server
    {"type": "turn_start", "turnId", "personId", "source", "scene", "actions"}
    <binary>  float32 mono PCM at 16 kHz for the open turn (pre-roll first)
    {"type": "turn_end", "turnId", "cancelled", "scene", "actions"}
    {"type": "text_command", "turnId", "text", "scene", "actions"}
  Body Lab (web/src/lab) only:
    {"type": "lab_hello"}                                     start the idea writer early
    turn_start / turn_end with "mode": "idea"                 the speech is an idea to name, not a command
    {"type": "rework", "id", "how", "idea", "other"}          reword an idea (ideas.py)
    {"type": "suggest", "id", "idea", "branches", "board"}    Claude's own ideas branching from one bubble; with "other" from
                                                              the line connecting two, and with "angle" through what was said
    turn_start / turn_end with "mode": "angle"                the speech is the angle for a suggest; only the words come back
    turn_end with "mode": "structure" and "board"             the speech says how to organise the board
    {"type": "lab_log", "session", "events"}                  append to lab-sessions/<session>.jsonl
  server -> browser
    {"type": "status", "stt", "llm"}
    {"type": "partial" | "final", "turnId", "text"}           a Body Lab final that was only filler has "text": "" and "skipped": the words;
                                                              a final also has "audio_s" and "audio_dbfs" (about -90 silent mic, -30 speech)
    {"type": "result", "turnId", "text", "result", "tier", "timings"}
    {"type": "idea", "id", "text", "emoji", "ms"} or {"type": "idea", "id", "error"}   (Body Lab; id is the rework id or the turnId)
    {"type": "ideas", "id", "ideas": [{"text", "emoji"}], "angle", "ms"} or with "error"   (Body Lab; answer to suggest)
    {"type": "structure", "id", "kind", ...} or with "error"                          (Body Lab; id is the turnId; see ideas.parse_structure)
"""

import asyncio
import contextlib
import json
import logging
import os
import re
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import uvicorn
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles

from .ideas import IdeaError, Reworker
from . import ollama, replay
from .resolver import Resolution, Resolver, has_credentials
from .stt import SAMPLE_RATE, Transcriber
from .trace import TraceLog

ROOT = Path(__file__).resolve().parents[3]
load_dotenv(ROOT / ".env")

log = logging.getLogger("natter")
PARTIAL_INTERVAL_S = 0.35
MAX_TURN_SAMPLES = SAMPLE_RATE * 25

transcriber = Transcriber()
resolver = Resolver()
reworker = Reworker()
traces = TraceLog(ROOT / "traces")
LAB_SESSIONS = ROOT / "lab-sessions"
LAB_RECORDINGS = ROOT / "lab-recordings"
RECORDING_LIMIT = 1_000_000_000  # bytes per session: about two hours at the 8 MB a minute the Lab records
RECORDINGS_KEEP = 5_000_000_000  # bytes of recordings kept in all; the oldest go first
stt_thread = ThreadPoolExecutor(max_workers=1)
sockets: set[WebSocket] = set()
stt_state = {"stt": "loading"}
_env_key = os.environ.get("ANTHROPIC_API_KEY")


def refresh_env() -> None:
    """Reread .env, so a key added while the server runs works without a restart."""
    global _env_key
    load_dotenv(ROOT / ".env", override=True)
    key = os.environ.get("ANTHROPIC_API_KEY")
    if key != _env_key:
        _env_key = key
        resolver.reset_client()
        reworker.reset_client()


def status() -> dict:
    refresh_env()
    llm = "ready" if has_credentials() else "claude_code"
    if ollama.fallback.active:
        llm = "ollama" if ollama.fallback.local_ready else "ollama_failed" if ollama.fallback.local_ready is False else "ollama_loading"
    return {"type": "status", "stt": stt_state["stt"], "llm": llm}


async def broadcast(message: dict) -> None:
    for ws in list(sockets):
        with contextlib.suppress(Exception):
            await ws.send_json(message)


async def load_model() -> None:
    loop = asyncio.get_running_loop()
    try:
        seconds = await loop.run_in_executor(stt_thread, transcriber.load)
        log.info("speech model ready in %.1fs", seconds)
        stt_state["stt"] = "ready"
    except Exception:
        log.exception("speech model failed to load")
        stt_state["stt"] = "failed"
    await broadcast(status())


@contextlib.asynccontextmanager
async def lifespan(_: FastAPI):
    task = asyncio.create_task(load_model())
    resolver.warm_up()
    yield
    task.cancel()


app = FastAPI(lifespan=lifespan)
app.include_router(replay.router)


class Guess:
    """Resolving the words heard so far, before the hand comes down (a head start).

    Only used if the final words match and nothing changed meanwhile; never applied early."""

    def __init__(self, text: str, scene: dict, actions: list[dict], previous: dict | None):
        self.key = words(text)
        self.scene_version = scene.get("version")
        self.previous = previous
        self.task = asyncio.create_task(resolver.resolve(text, scene, actions, previous))

    def matches(self, text: str, scene: dict, previous: dict | None) -> bool:
        return self.key == words(text) and self.scene_version == scene.get("version") and self.previous is previous

    def drop(self) -> None:
        self.task.cancel()


def words(text: str) -> str:
    """The words of a transcript, ignoring case and punctuation, which partials and finals punctuate differently."""
    return " ".join(re.findall(r"[a-z0-9']+", text.lower()))


class Turn:
    def __init__(self, turn_id: str, person_id: str, source: str, scene: dict | None = None, actions: list[dict] | None = None):
        self.id = turn_id
        self.person_id = person_id
        self.source = source
        self.scene = scene
        self.actions = actions or []
        self.guess: Guess | None = None
        self.chunks: list[np.ndarray] = []
        self.samples = 0
        self.transcribed_samples = 0
        self.partials = 0
        self.last_partial = ""
        self.started = time.perf_counter()
        self.partial_task: asyncio.Task | None = None

    def add(self, pcm: np.ndarray) -> None:
        if self.samples + len(pcm) > MAX_TURN_SAMPLES:
            return
        self.chunks.append(pcm)
        self.samples += len(pcm)

    def audio(self) -> np.ndarray:
        return np.concatenate(self.chunks) if self.chunks else np.zeros(0, dtype=np.float32)

    def guess_ahead(self, text: str, previous: dict | None) -> None:
        """Start resolving the latest partial, replacing the guess for older words, but only when a
        session is free: queueing guesses would only delay the command they are meant to speed up."""
        if not self.scene or (self.guess and self.guess.key == words(text)) or not resolver.can_start_now():
            return
        if self.guess:
            self.guess.drop()
        self.guess = Guess(text, self.scene, self.actions, previous)

    def drop_guess(self) -> None:
        if self.guess:
            self.guess.drop()


async def transcribe(audio: np.ndarray) -> str:
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(stt_thread, transcriber.transcribe, audio)


SPOKEN_DBFS = -50.0  # louder than this over a whole turn: someone was speaking, whatever the speech model made of it
LEAD_IN_S = 0.25


async def transcribe_final(audio: np.ndarray, level: float) -> str:
    """A finished turn's words. The speech model sometimes returns nothing for a clip that starts
    abruptly in the middle of speech (the pre-roll cuts into what was being said before the hand
    closed): in two recorded sessions "Camera." and "Risks." came back empty that way, and both
    read correctly with a moment of silence in front. So a loud turn that came back empty is read
    once more with that lead-in."""
    text = await transcribe(audio)
    if text.strip() or level < SPOKEN_DBFS:
        return text
    again = await transcribe(np.concatenate([np.zeros(int(LEAD_IN_S * SAMPLE_RATE), dtype=np.float32), audio]))
    log.info("final transcription was empty at %.1f dBFS; with a lead-in: %r", level, again)
    return again


async def partial_loop(ws: WebSocket, turn: Turn, session: dict) -> None:
    while True:
        await asyncio.sleep(PARTIAL_INTERVAL_S)
        if not transcriber.ready or turn.samples == turn.transcribed_samples:
            continue
        turn.transcribed_samples = turn.samples
        text = await transcribe(turn.audio())
        if text and text != turn.last_partial:
            turn.last_partial = text
            turn.partials += 1
            await ws.send_json({"type": "partial", "turnId": turn.id, "text": text})
        if text:
            turn.guess_ahead(text, session.get("previous"))


_tasks: set[asyncio.Task] = set()


def spawn(coro) -> None:
    """Run in the background, keeping a reference so the task isn't garbage-collected mid-turn."""
    task = asyncio.create_task(coro)
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)


async def finish(ws: WebSocket, text: str, msg: dict, session: dict, timings: dict, person_id: str, source: str, guess: Guess | None = None) -> None:
    scene = msg.get("scene") or {}
    actions = msg.get("actions") or []
    start = time.perf_counter()
    refresh_env()
    try:
        if guess and guess.matches(text, scene, session.get("previous")):
            timings["head_start"] = "used"
            resolution = await guess.task
        else:
            if guess:
                timings["head_start"] = "discarded"
                guess.drop()
            resolution = await resolver.resolve(text, scene, actions, session.get("previous"))
    except Exception as e:
        log.exception("resolver failed")
        resolution = Resolution({"kind": "error", "reason": "model_failed"}, "none", [{"error": repr(e)}])
    timings["resolve_ms"] = round((time.perf_counter() - start) * 1000)
    await ws.send_json(status())
    await ws.send_json({
        "type": "result",
        "turnId": msg.get("turnId"),
        "text": text,
        "result": resolution.result,
        "tier": resolution.tier,
        "timings": timings,
    })
    session["previous"] = {"utterance": text, "result": resolution.result}
    traces.write({
        "t": time.time(),
        "turnId": msg.get("turnId"),
        "personId": person_id,
        "source": source,
        "text": text,
        "sceneVersion": scene.get("version"),
        "objectCount": len(scene.get("objects", [])),
        "tier": resolution.tier,
        "attempts": resolution.attempts,
        "result": resolution.result,
        "timings": timings,
    })


async def send_lab(ws: WebSocket, kind: str, ident: str, call, record: dict) -> None:
    """Body Lab: run one request to Claude and send the answer (or an error) back as `kind` under `ident`."""
    refresh_env()
    try:
        answer = await call
    except (IdeaError, TimeoutError) as e:
        log.warning("%s failed: %s", kind, e)
        answer = {"error": "timeout" if isinstance(e, TimeoutError) else "model_failed"}
    traces.write({"turn_id": ident, "source": "lab", "request": kind, **record, "answer": answer})
    with contextlib.suppress(Exception):
        await ws.send_json(status())
        await ws.send_json({"type": kind, "id": ident, **answer})


# Sounds people make while a hand is up that aren't ideas. In one recorded session "Well,",
# "Mm-hmm" and "Whoa." each became a bubble that then had to be deleted.
FILLER = frozenset(
    "well oh ooh whoa wow mm mmm hm hmm mhm uh um er erm ah aha huh ugh oops hey yeah yep yes no nope ok okay right so and like".split()
)


def is_filler(text: str) -> bool:
    """True when what was heard is only one to three filler words."""
    words = re.findall(r"[a-z]+", text.lower())
    return 0 < len(words) <= 3 and all(w in FILLER for w in words)


def write_lab_log(session: str, events: list) -> None:
    """Body Lab: append a batch of session events (gesture readings and board events; no audio or video)."""
    name = re.sub(r"[^0-9A-Za-z_-]", "", session)[:40]
    if not name or not events:
        return
    LAB_SESSIONS.mkdir(exist_ok=True)
    with (LAB_SESSIONS / f"{name}.jsonl").open("a") as f:
        for event in events[:5000]:
            f.write(json.dumps(event, separators=(",", ":"), ensure_ascii=False) + "\n")


def write_lab_recording(session: str, data: bytes) -> bool:
    """Body Lab: append a piece of camera video to lab-recordings/<session>.webm. Only when the
    person pressed Record; the file stays on this computer. False when nothing was written."""
    name = re.sub(r"[^0-9A-Za-z_-]", "", session)[:40]
    if not name or not data:
        return False
    LAB_RECORDINGS.mkdir(exist_ok=True)
    path = LAB_RECORDINGS / f"{name}.webm"
    if (path.stat().st_size if path.exists() else 0) + len(data) > RECORDING_LIMIT:
        return False
    new = not path.exists()
    with path.open("ab") as f:
        f.write(data)
    if new:
        prune_lab_recordings(keep=path)
    return True


def prune_lab_recordings(keep: Path) -> None:
    """Delete the oldest recordings until the folder is under RECORDINGS_KEEP. Never the one being written."""
    files = sorted((p for p in LAB_RECORDINGS.glob("*.webm") if p != keep), key=lambda p: p.stat().st_mtime)
    total = sum(p.stat().st_size for p in files)
    while files and total > RECORDINGS_KEEP:
        oldest = files.pop(0)
        total -= oldest.stat().st_size
        with contextlib.suppress(OSError):
            oldest.unlink()
            log.info("removed old recording %s", oldest.name)


@app.post("/lab-recording/{session}")
async def lab_recording(session: str, request: Request) -> dict:
    if not write_lab_recording(session, await request.body()):
        raise HTTPException(status_code=413, detail="recording not saved")
    return {"saved": True}


TRANSCRIBE_LIMIT = 16000 * 4 * 40  # bytes: forty seconds of sound at most in one piece


@app.post("/transcribe")
async def transcribe_piece(request: Request) -> dict:
    """One piece of recorded sound (16 kHz samples, 32-bit floats) to words, for writing a session's
    transcript afterwards with the speech model this server already has loaded."""
    data = await request.body()
    if len(data) > TRANSCRIBE_LIMIT or len(data) % 4:
        raise HTTPException(status_code=413, detail="one piece of at most forty seconds")
    if not transcriber.ready:
        raise HTTPException(status_code=503, detail="speech model not ready")
    return {"text": await transcribe(np.frombuffer(data, dtype=np.float32))}


async def send_idea(ws: WebSocket, ident: str, how: str, idea: str = "", other: str = "", heard: str = "", zone: str | None = None, board: list[str] | None = None) -> None:
    """Body Lab: ask Claude for a bubble's words and send them back under `ident`."""
    refresh_env()
    try:
        answer = await reworker.rework(how, idea, other, heard, zone, board)
    except (IdeaError, TimeoutError) as e:
        log.warning("idea %s failed: %s", how, e)
        answer = {"error": "timeout" if isinstance(e, TimeoutError) else "model_failed"}
    traces.write({"turn_id": ident, "source": "lab", "how": how, "idea": idea, "other": other, "heard": heard, "zone": zone, "board": board, "answer": answer})
    with contextlib.suppress(Exception):
        await ws.send_json(status())
        await ws.send_json({"type": "idea", "id": ident, **answer})


@app.websocket("/ws")
async def websocket(ws: WebSocket) -> None:
    await ws.accept()
    sockets.add(ws)
    await ws.send_json(status())
    session: dict = {"previous": None}
    turn: Turn | None = None
    try:
        while True:
            message = await ws.receive()
            if message["type"] == "websocket.disconnect":
                break
            if message.get("bytes") is not None:
                if turn is not None:
                    turn.add(np.frombuffer(message["bytes"], dtype=np.float32).copy())
                continue
            msg = json.loads(message["text"])
            kind = msg.get("type")

            if kind == "turn_start":
                if turn and turn.partial_task:
                    turn.partial_task.cancel()
                    turn.drop_guess()
                turn = Turn(msg["turnId"], msg.get("personId", "?"), msg.get("source", "gesture"), msg.get("scene"), msg.get("actions"))
                turn.partial_task = asyncio.create_task(partial_loop(ws, turn, session))

            elif kind == "turn_end" and turn is not None and turn.id == msg.get("turnId"):
                ended, turn = turn, None
                if ended.partial_task:
                    ended.partial_task.cancel()
                    try:
                        await ended.partial_task
                    except asyncio.CancelledError:
                        pass
                    except Exception:
                        log.exception("partial transcription failed")
                audio = ended.audio()
                # Loudness in dBFS tells a silent mic (about -90) apart from speech that wasn't recognised (about -30).
                level = 20 * np.log10(np.sqrt(np.mean(audio**2)) + 1e-9) if audio.size else -180.0
                timings = {"audio_s": round(ended.samples / SAMPLE_RATE, 2), "audio_dbfs": round(float(level), 1), "partials": ended.partials}
                if msg.get("cancelled"):
                    ended.drop_guess()
                    await ws.send_json({"type": "result", "turnId": ended.id, "text": "", "result": {"kind": "none", "reason": "cancelled"}, "tier": "none", "timings": timings})
                    continue
                if not transcriber.ready:
                    await ws.send_json({"type": "result", "turnId": ended.id, "text": "", "result": {"kind": "error", "reason": "stt_not_ready"}, "tier": "none", "timings": timings})
                    continue
                start = time.perf_counter()
                try:
                    text = await transcribe_final(audio, float(level))
                except Exception:
                    log.exception("final transcription failed")
                    await ws.send_json({"type": "result", "turnId": ended.id, "text": "", "result": {"kind": "error", "reason": "stt_failed"}, "tier": "none", "timings": timings})
                    continue
                timings["stt_final_ms"] = round((time.perf_counter() - start) * 1000)
                # With every final, so the Lab's log can tell a quiet microphone from someone saying nothing.
                heard = {"audio_s": timings["audio_s"], "audio_dbfs": timings["audio_dbfs"]}
                if msg.get("mode") == "zone_name":
                    await ws.send_json({"type": "final", "turnId": ended.id, **heard, "text": text})
                    continue  # A zone title is the words heard; no model or board command.
                if msg.get("mode") == "angle":
                    # The lens for a suggestion; the Lab sends it back with the suggest request. A noise is no angle.
                    await ws.send_json({"type": "final", "turnId": ended.id, **heard, "text": "" if is_filler(text) else text})
                    continue
                if msg.get("mode") in ("idea", "structure") and is_filler(text):
                    # A noise made while a hand was up, not an idea: tell the Lab nothing was said, and what was skipped.
                    await ws.send_json({"type": "final", "turnId": ended.id, **heard, "text": "", "skipped": text.strip()})
                    continue
                await ws.send_json({"type": "final", "turnId": ended.id, **heard, "text": text})
                if msg.get("mode") == "structure":
                    board = [
                        {"id": str(b.get("id")), "text": str(b.get("text")), "family": str(b.get("family") or ""), "colour": str(b.get("colour") or ""), "starred": bool(b.get("starred"))}
                        for b in msg.get("board") or []
                        if isinstance(b, dict)
                    ]
                    if text.strip() and board:
                        spawn(send_lab(ws, "structure", ended.id, reworker.structure(text, board), {"heard": text, "board": board}))
                    continue
                if msg.get("mode") == "idea":
                    if text.strip():
                        spawn(send_idea(ws, ended.id, "name", heard=text))
                    continue
                spawn(finish(ws, text, msg, session, timings, ended.person_id, ended.source, ended.guess))

            elif kind == "lab_hello":
                reworker.warm_up()

            elif kind == "lab_log":
                write_lab_log(str(msg.get("session", "")), msg.get("events") or [])

            elif kind == "suggest":
                idea = str(msg.get("idea", ""))
                branches = [str(b) for b in msg.get("branches") or []]
                board = [str(b) for b in msg.get("board") or []]
                zone = str(msg["zone"]) if msg.get("zone") is not None else None
                other, angle = str(msg.get("other") or ""), str(msg.get("angle") or "")
                linked = [str(b) for b in msg.get("linked") or []]
                spawn(send_lab(ws, "ideas", str(msg.get("id")), reworker.suggest(idea, branches, board, zone, other, angle, linked), {"idea": idea, "other": other, "linked": linked, "angle": angle, "branches": branches, "board": board, "zone": zone}))

            elif kind == "rework":
                zone = str(msg["zone"]) if msg.get("zone") is not None else None
                board = [str(b) for b in msg.get("board") or []]
                spawn(send_idea(ws, str(msg.get("id")), str(msg.get("how")), str(msg.get("idea", "")), str(msg.get("other", "")), zone=zone, board=board))

            elif kind == "text_command":
                spawn(finish(ws, msg.get("text", ""), msg, session, {}, "keyboard", "text"))
    except WebSocketDisconnect:
        pass
    finally:
        sockets.discard(ws)
        if turn and turn.partial_task:
            turn.partial_task.cancel()
            turn.drop_guess()


DIST = ROOT / "web" / "dist"
if DIST.exists():
    app.mount("/", StaticFiles(directory=DIST, html=True), name="web")


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    for noisy in ("httpx", "httpx2", "huggingface_hub"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
    port = int(os.environ.get("NATTER_PORT") or os.environ.get("GESTURE_ROOM_PORT", "8777"))
    log.info("serving on http://127.0.0.1:%d", port)
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")
