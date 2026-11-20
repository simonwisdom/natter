"""Instant commands that never need a model."""

import re

_PATTERNS: list[tuple[re.Pattern[str], dict]] = [
    (re.compile(r"^(undo|undo that|put it back|go back|take that back)$"), {"kind": "actions", "calls": [{"name": "undo", "input": {}}], "summary": "Undo"}),
    (re.compile(r"^(redo|redo that)$"), {"kind": "actions", "calls": [{"name": "redo", "input": {}}], "summary": "Redo"}),
    (re.compile(r"^(yes|yes do it|do it|confirm|go ahead|yep)$"), {"kind": "actions", "calls": [{"name": "confirm", "input": {}}], "summary": "Confirm"}),
    (re.compile(r"^(no|don't|do not|nope|reject)$"), {"kind": "actions", "calls": [{"name": "reject", "input": {}}], "summary": "Reject"}),
    (re.compile(r"^(cancel|never mind|nevermind|forget it|stop)$"), {"kind": "none", "reason": "cancelled"}),
]


def normalise(text: str) -> str:
    text = text.lower().strip()
    text = re.sub(r"[^\w\s']", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    text = re.sub(r"^(okay|ok|um|uh|so)\s+", "", text)
    text = re.sub(r"\s+please$", "", text)
    return text


def match(text: str) -> dict | None:
    """Return a ResolverResult for a grammar command, or None to fall through to the model."""
    norm = normalise(text)
    if not norm:
        return {"kind": "none", "reason": "not_a_command"}
    for pattern, result in _PATTERNS:
        if pattern.match(norm):
            copy = dict(result)
            if "calls" in copy:
                copy["calls"] = [dict(c) for c in copy["calls"]]
            return copy
    return None
