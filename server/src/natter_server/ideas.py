"""Words for Body Lab bubbles: name a spoken idea, or rework one the way it was handled.

In the lab, hands do things to idea bubbles and Claude supplies the words that result:
  name      someone said an idea aloud; give it a short label
  further   the bubble was stretched; push the idea further
  smaller   it was squeezed; the smallest version worth trying
  opposite  the hands crossed over; the reverse idea
  combine   two bubbles were pushed together; one idea that is both
  area      the board was zoomed out; a name for one area of the canvas, from the ideas in it
  suggest   someone made a victory sign on a bubble, or on the line connecting two; two new ideas
            branching from it, through the angle they said aloud if they said one
  structure someone raised both hands and said how to organise the board; axes or zones, and where each bubble goes

Same two routes as the resolver: the API with a key, the user's Claude Code login without.
"""

import contextlib
import json
import logging
import os
import time

import anthropic
from claude_agent_sdk import ClaudeSDKError

from . import claude_code, ollama

MODEL = "claude-haiku-4-5"
HOWS = ("name", "further", "smaller", "opposite", "combine", "area")
MAX_BOARD = 60  # bubbles described to Claude
API_TIMEOUT = 6
CLAUDE_CODE_TIMEOUT = 10
MAX_LABEL = 40
LABEL_SCHEMA = {
    "type": "object", "properties": {"text": {"type": "string", "minLength": 1, "maxLength": MAX_LABEL}, "emoji": {"type": "string"}},
    "required": ["text", "emoji"], "additionalProperties": False,
}
MAX_ANGLE = 24
MAX_HEARD_LABEL = 36  # the most a spoken idea's label may run to

log = logging.getLogger("natter")
SUGGEST_SCHEMA = {
    "type": "object", "properties": {"ideas": {"type": "array", "minItems": 2, "maxItems": 2, "items": LABEL_SCHEMA}, "angle": {"type": "string", "maxLength": MAX_ANGLE}},
    "required": ["ideas"], "additionalProperties": False,
}
LOCAL_SYSTEM = """You supply short labels for ideas on a shared brainstorm board. Answer only JSON matching the supplied schema.
Use only this request. The zone, board and branches describe the current scope; never draw on another zone.
Write concrete, everyday labels, two to four words, at most 28 characters, sentence case, with one fitting emoji.
Follow the operation in <how>:
- name: tidy the words in <heard> into a short label, keeping their meaning and wording. Up to six words is fine. A misspelled or foreign word is a mishearing: write the ordinary word it sounds like when you are sure of it, and otherwise keep what was heard.
- further: make <idea> bolder, in the same direction.
- smaller: propose an easier, smaller first step toward <idea>.
- opposite: propose the reverse of <idea>.
- combine: propose one idea that uses both <idea> and <other>.
- area: <board> lists the ideas in one area of a larger canvas. Name what they have in common in one to three words, like a place name on a map.
- suggest: invent exactly two NEW, concrete ideas branching from <idea>. Neither may repeat or lightly reword the source idea, the board or existing branches. Stay in the same subject. A garden might branch into a seed swap or a rain barrel, not another garden. With <other>, the two new ideas come from <idea> and <other> taken together. With <linked>, they come from <idea> and every linked idea taken together, not from one or two of them. With <angle>, both ideas answer that angle ("risks" gives two risks, "similarities" gives two things the ideas share), and "angle" in the answer repeats it in one to three words.
"""

SYSTEM = """You write the labels on idea bubbles in a brainstorm. People stand in front of a big screen and shape ideas with their hands; you supply the words.

Each request stands alone. Use only the ideas in the current request, never earlier requests or answers. When <zone> is present, <board> and <branches> contain only bubbles currently in that zone: use its name and those bubbles as context, and do not draw on other zones.

Each request has a <how> and one or two ideas:
- name: <heard> is what someone said aloud, as transcribed. Tidy it into a label and nothing more: keep their own words and their meaning. Drop filler, false starts and lead-ins like "what if we" or "maybe we could", and if it is long keep the key phrase. The transcription mishears short words: a word that is misspelled, is not a real word, or is in another language than the rest is a mishearing, so write the ordinary word or name it sounds like ("dugs" is "Dogs", "pět" is "Pet", "kat" is "Cat", "niet jo" is "Nietzsche"). Only when you are sure what was meant: if you are not, keep what was heard exactly as it is. Never make up a different phrase. Do not reinterpret it, improve it, make it more specific or swap in different words. If what they said is already short, use it almost as it is. For this kind only, up to six words and 36 characters is fine.
- further: take <idea> further in the same direction, to a bolder version that is still a real suggestion.
- smaller: the smallest, easiest version of <idea> that would still be worth trying.
- opposite: the reverse of <idea>, as a real suggestion someone could argue for.
- combine: one idea that genuinely uses both <idea> and <other>, not the two names joined together.
- area: there is no <idea>. <board> lists the ideas in one area of a larger canvas, which is being shown small from far away. Name the area: what these ideas have in common, in one to three words and at most 22 characters, like a place name on a map ("Martial arts", "Weekend plans", "Dogs and thinkers"). Not a sentence, and not one idea's own label unless it is the only one.

Rules for the label:
- Two to four words, at most 28 characters, no full stop, sentence case. It is read from the back of a room.
- Concrete and specific, in plain everyday words.
- Stay in the subject and tone of the ideas you are given. The board can be about anything: a holiday, a story, a garden, a science question, a party. Do not assume a workplace, a product or a company, and do not reach for business or startup language unless the ideas themselves are about that.
- Pick one emoji that fits.

Never ask a question, explain or refuse. If an idea is unclear, odd or looks misheard, make your best guess and still answer with a label.

For those five kinds, answer with only a JSON object and nothing else: {"text": "<label>", "emoji": "<one emoji>"}

Two more kinds answer differently.

- suggest: someone made a victory sign on <idea>, asking you for more. <branches> are the ideas already growing from it and <board> is everything else in scope (only the current zone when <zone> is present). Offer exactly two new ideas that branch from <idea>: different from each other and from everything listed, the kind of thing a thoughtful friend who knows the subject would add, in the same spirit as what is already there, not a restatement or generic advice. Each follows the label rules above. Answer with only: {"ideas": [{"text": "<label>", "emoji": "<one emoji>"}, {"text": "<label>", "emoji": "<one emoji>"}]}
  Two optional parts change what is asked for:
  - <other>: the victory sign was made on the line connecting <idea> and <other>. Both stay on the board. The two new ideas come out of the pair taken together: what links them, what one brings to the other, what only exists because both do. Not a merge of the two names, and not an idea about just one of them.
  - <linked>: the ideas joined to <idea> by a line. The victory sign was made on <idea> itself, the hub, so the two new ideas come out of <idea> and the linked ideas taken together: what the whole group points to, what only exists because all of them do. Each new idea must visibly draw on <idea> and at least two of the linked ideas, so that someone reading the label can tell which; an idea that would fit <idea> alone, with the linked ideas taken away, is wrong. Not a list of their names. Linked ideas are in scope even when they sit in another zone.
  - <angle>: what the person said aloud while holding the sign, as transcribed: the lens to look through. "risks" asks for two risks, "similarities" for two things the pair share, "differences" for two ways they differ, "cheaper" or "for kids" for two versions like that, "what's missing" for two gaps. Any word or phrase can be an angle; follow it as a thoughtful friend would understand it. The transcription mishears short words and splits long ones, so read an odd or foreign-looking word, or a run of small words, as the ordinary word it sounds like ("similar it ease" is "similarities", "wrists" may be "risks"). Both new ideas must clearly answer the angle, and each is still a concrete label, not a sentence about the angle. When <angle> is present, add "angle" to the answer: the angle as you understood it, in one to three plain words, lower case, at most 24 characters, for example {"ideas": [...], "angle": "similarities"}. If what was said is not an angle at all (a noise, half a word, talk to someone else such as "hang on, is it recording"), answer as if nothing had been said and leave "angle" out. Never make up an angle that was not said.

- structure: someone raised both hands and said, in <heard>, how they want the whole board organised. <board> lists every bubble as "id: label", with notes in brackets where they apply: its family (the idea it branches from), its colour on screen (a family shares one colour), and whether it has been starred. Work out which arrangement they asked for and answer with only one of these JSON objects:
  - Two dimensions, or one ("sort by how fun they are", "cost against fun"): {"kind": "axes", "x": ["<low end>", "<high end>"], "y": ["<low end>", "<high end>"], "place": [{"id": "<id>", "x": <0 to 1>, "y": <0 to 1>}, ...]}. x runs left to right and y bottom to top, so name the ends in that order. If they gave only one dimension, put it on x and choose a second one for y that suits what these particular ideas are about. Place every bubble by your honest judgement of that idea, and use the whole range: a board where everything sits in the middle tells nobody anything.
  - Named groups or piles ("this week, someday, never", "group by theme", "by colour", "starred ones apart"): {"kind": "zones", "zones": ["<name>", ...], "place": [{"id": "<id>", "zone": <index into zones>}, ...]}. Two to six zones, and as few as do the job. If they asked for groups without naming them, name the groups you see. Grouping by colour or by family means one zone per family, named after what that family is about, not after the colour. Put every bubble in one.
  - They asked to take the structure away: {"kind": "clear"}
  - What they said is not about organising the board: {"kind": "none"}
  Axis ends and zone names are at most 14 characters. Use only ids from <board>."""

class IdeaError(Exception):
    pass


def build_prompt(how: str, idea: str = "", other: str = "", heard: str = "", zone: str | None = None, board: list[str] | None = None) -> str:
    if how not in HOWS:
        raise IdeaError(f"unknown how: {how!r}")
    parts = [f"<how>{how}</how>"]
    if how == "area":
        rows = "\n".join(f"- {item}" for item in (board or [])[:MAX_BOARD]) or "(none)"
        parts.append(f"<board>\n{rows}\n</board>")
    elif how == "name":
        parts.append(f"<heard>{heard}</heard>")
    else:
        parts.append(f"<idea>{idea}</idea>")
        if how == "combine":
            parts.append(f"<other>{other}</other>")
        if zone is not None:
            parts.append(_zone_prompt(zone, board or []))
    return "\n".join(parts)


def _zone_prompt(zone: str, board: list[str]) -> str:
    rows = "\n".join(f"- {item}" for item in board[:MAX_BOARD]) or "(none)"
    return f"<zone>{zone}</zone>\n<board>\n{rows}\n</board>"


def build_suggest_prompt(idea: str, branches: list[str], board: list[str], zone: str | None = None, other: str = "", angle: str = "", linked: list[str] | None = None) -> str:
    lines = lambda items: "\n".join(f"- {i}" for i in items[:MAX_BOARD]) or "(none)"
    context = _zone_prompt(zone, board) if zone is not None else f"<board>\n{lines(board)}\n</board>"
    joined = [item for item in linked or [] if item.strip()]
    extra = (f"\n<other>{other}</other>" if other.strip() else "") + (f"\n<linked>\n{lines(joined)}\n</linked>" if joined else "") + (f"\n<angle>{angle.strip()[:200]}</angle>" if angle.strip() else "")
    return f"<how>suggest</how>\n<idea>{idea}</idea>{extra}\n<branches>\n{lines(branches)}\n</branches>\n{context}"


def build_structure_prompt(heard: str, board: list[dict]) -> str:
    def row(b: dict) -> str:
        notes = [f"family: {b['family']}"] if b.get("family") and b["family"] != b["text"] else []
        notes += [f"colour: {b['colour']}"] if b.get("colour") else []
        notes += ["starred"] if b.get("starred") else []
        return f"{b['id']}: {b['text']}" + (f" ({', '.join(notes)})" if notes else "")

    rows = "\n".join(row(b) for b in board[:MAX_BOARD])
    return f"<how>structure</how>\n<heard>{heard}</heard>\n<board>\n{rows}\n</board>"


def _json(text: str) -> dict:
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end < start:
        raise IdeaError(f"no JSON object in {text[:200]!r}")
    try:
        data = json.loads(text[start : end + 1])
    except json.JSONDecodeError as e:
        raise IdeaError(f"bad JSON: {e}") from e
    if not isinstance(data, dict):
        raise IdeaError(f"not an object: {data!r}")
    return data


def parse_ideas(text: str) -> list[dict]:
    """Pull the list of {"text", "emoji"} out of a suggest answer."""
    items = _json(text).get("ideas")
    if not isinstance(items, list):
        raise IdeaError("no ideas list")
    ideas = []
    for item in items:
        with contextlib.suppress(IdeaError):
            ideas.append(parse(json.dumps(item)))
    if not ideas:
        raise IdeaError("no usable ideas")
    return ideas


def parse_angle(text: str) -> str:
    """The angle Claude understood, tidied for a label on the line; empty when it gave none."""
    angle = _json(text).get("angle")
    return " ".join(angle.split()).rstrip(".")[:MAX_ANGLE] if isinstance(angle, str) else ""


def _short(value, limit: int = 20) -> str:
    return str(value).strip()[:limit]


def _unit(value) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise IdeaError(f"not a number: {value!r}")
    return min(1.0, max(0.0, float(value)))


def parse_structure(text: str, ids: set[str]) -> dict:
    """Check a structure answer and drop placements for bubbles that aren't on the board."""
    data = _json(text)
    kind = data.get("kind")
    if kind in ("clear", "none"):
        return {"kind": kind}
    place = [p for p in data.get("place") or [] if isinstance(p, dict) and p.get("id") in ids]
    if kind == "axes":
        x, y = data.get("x"), data.get("y")
        if not (isinstance(x, list) and isinstance(y, list) and len(x) == 2 and len(y) == 2):
            raise IdeaError("axes need two ends each")
        return {
            "kind": "axes",
            "x": [_short(v) for v in x],
            "y": [_short(v) for v in y],
            "place": [{"id": p["id"], "x": _unit(p.get("x")), "y": _unit(p.get("y"))} for p in place],
        }
    if kind == "zones":
        zones = data.get("zones")
        if not isinstance(zones, list) or not 2 <= len(zones) <= 6:
            raise IdeaError("zones need two to six names")
        placed = [p for p in place if isinstance(p.get("zone"), int) and not isinstance(p.get("zone"), bool) and 0 <= p["zone"] < len(zones)]
        return {"kind": "zones", "zones": [_short(z) for z in zones], "place": [{"id": p["id"], "zone": p["zone"]} for p in placed]}
    raise IdeaError(f"unknown kind: {kind!r}")


def plain_label(heard: str) -> str:
    """What was heard, cut to fit a bubble: the label when Claude gave none."""
    words = " ".join(heard.split()).rstrip(".,!?")
    if len(words) <= MAX_HEARD_LABEL:
        return words
    return words[:MAX_HEARD_LABEL].rsplit(" ", 1)[0].rstrip(".,!?") + "…"


def fit_label(label: str) -> str:
    """A label that fits a bubble. One that reaches the limit was cut there, by the schema or here,
    often mid-word: end it at the last whole word instead."""
    label = " ".join(label.split()).rstrip(".")
    if len(label) < MAX_LABEL:
        return label
    cut = label[:MAX_LABEL]
    whole = cut.rsplit(" ", 1)[0].rstrip(".,!?:;-") if " " in cut else cut[: MAX_LABEL - 1]
    return whole + "…"


def parse(text: str) -> dict:
    """Pull {"text", "emoji"} out of the answer, tolerating a code fence around it."""
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end < start:
        raise IdeaError(f"no JSON object in {text[:200]!r}")
    try:
        data = json.loads(text[start : end + 1])
    except json.JSONDecodeError as e:
        raise IdeaError(f"bad JSON: {e}") from e
    label = data.get("text") if isinstance(data, dict) else None
    if not isinstance(label, str) or not label.strip():
        raise IdeaError(f"no label in {data!r}")
    emoji = data.get("emoji")
    return {"text": fit_label(label), "emoji": emoji.strip()[:8] if isinstance(emoji, str) else ""}


class Reworker:
    def __init__(self, client: anthropic.AsyncAnthropic | None = None, session: claude_code.Session | None = None):
        self._client = client
        # Fresh conversations prevent context from an earlier zone leaking into this one.
        self._session = session or claude_code.Session(MODEL, SYSTEM, thinking=False, recycle_after=1)

    def reset_client(self) -> None:
        self._client = None

    def warm_up(self) -> None:
        if not _has_key() and not ollama.fallback.local_only:
            self._session.start()

    async def rework(self, how: str, idea: str = "", other: str = "", heard: str = "", zone: str | None = None, board: list[str] | None = None) -> dict:
        """Return {"text", "emoji", "ms"}. Raises IdeaError or TimeoutError."""
        start = time.perf_counter()
        text, backend = await self._ask(build_prompt(how, idea, other, heard, zone, board), 200, LABEL_SCHEMA)
        try:
            answer = parse(text)
        except IdeaError:
            # Given talk that isn't an idea, Claude sometimes asks what was meant instead of answering.
            # The person's own words are then the label: a bubble must never fail to get its words.
            if how != "name" or not heard.strip():
                raise
            log.warning("no label for %r, using the words heard: %s", heard, text[:120])
            answer = {"text": plain_label(heard), "emoji": "💬"}
        return {**answer, "backend": backend, "ms": round((time.perf_counter() - start) * 1000)}

    async def suggest(self, idea: str, branches: list[str], board: list[str], zone: str | None = None, other: str = "", angle: str = "", linked: list[str] | None = None) -> dict:
        """Claude's own ideas branching from one bubble, or from two connected ones (`other`), through
        a spoken `angle` if there was one: {"ideas": [{"text", "emoji"}], "angle", "ms"}."""
        start = time.perf_counter()
        text, backend = await self._ask(build_suggest_prompt(idea, branches, board, zone, other, angle, linked), 300, SUGGEST_SCHEMA)
        try:
            suggestions = parse_ideas(text)
        except IdeaError:
            # Words said while asking that aren't an angle (talk to someone else, half a sentence) can
            # make Claude ask what was meant. Ask once more as if nothing had been said.
            if not angle.strip():
                raise
            log.warning("no ideas for the angle %r, asking again without it: %s", angle, text[:120])
            angle = ""
            text, backend = await self._ask(build_suggest_prompt(idea, branches, board, zone, other, "", linked), 300, SUGGEST_SCHEMA)
            suggestions = parse_ideas(text)
        understood = parse_angle(text) if angle.strip() else ""
        if backend == "ollama":
            # Small models often copy prompt labels. Never present those as new ideas.
            seen = {label.strip().casefold() for label in [idea, other, *(linked or []), *branches, *board]}
            fresh = []
            for suggestion in suggestions:
                label = suggestion["text"].strip().casefold()
                if label not in seen:
                    fresh.append(suggestion)
                    seen.add(label)
            if not fresh:
                raise IdeaError("Local model repeated existing ideas")
            suggestions = fresh
            # Small models rarely hand the angle back; what was heard is the next best label for the line.
            understood = understood or " ".join(angle.split())[:MAX_ANGLE]
        return {"ideas": suggestions, "angle": understood, "backend": backend, "ms": round((time.perf_counter() - start) * 1000)}

    async def structure(self, heard: str, board: list[dict]) -> dict:
        """How to organise the board, from what was said: a checked structure (see parse_structure) plus "ms"."""
        start = time.perf_counter()
        text, backend = await self._ask(build_structure_prompt(heard, board), 2000)
        return {**parse_structure(text, {b["id"] for b in board}), "backend": backend, "ms": round((time.perf_counter() - start) * 1000)}

    async def _ask(self, prompt: str, max_tokens: int, schema: dict | str = "json") -> tuple[str, str]:
        async def primary():
            return await self._ask_claude(prompt, max_tokens), "api" if _has_key() else "claude_code"

        async def local():
            system = SYSTEM if "<how>structure</how>" in prompt else LOCAL_SYSTEM
            return await ollama.fallback.chat(system, prompt, max_tokens, schema), "ollama"

        try:
            return await ollama.fallback.run(primary, local)
        except ollama.LocalError as e:
            raise IdeaError(str(e)) from e
        except anthropic.APIError as e:
            raise IdeaError(f"{type(e).__name__}: {e}") from e
        except (claude_code.AnswerError, ClaudeSDKError) as e:
            raise IdeaError(str(e)) from e

    async def _ask_claude(self, prompt: str, max_tokens: int) -> str:
        if _has_key():
            if self._client is None:
                self._client = anthropic.AsyncAnthropic(max_retries=0)
            try:
                response = await self._client.messages.create(
                    model=MODEL,
                    max_tokens=max_tokens,
                    system=SYSTEM,
                    messages=[{"role": "user", "content": prompt}],
                    timeout=API_TIMEOUT,
                )
            except anthropic.APITimeoutError as e:
                raise TimeoutError(str(e)) from e
            except (anthropic.APIStatusError, anthropic.APIConnectionError):
                raise
            return "".join(b.text for b in response.content if b.type == "text")
        text, _ = await self._session.ask_text(prompt, None, CLAUDE_CODE_TIMEOUT)
        return text


def _has_key() -> bool:
    return bool(os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"))
