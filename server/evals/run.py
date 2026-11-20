"""Resolver eval: run each spoken command against the starting board and check the result.

    cd server && uv run python evals/run.py

Calls Claude for real (about 21 requests to Haiku 4.5, plus Sonnet 5.5 escalations): through the
API with ANTHROPIC_API_KEY in ../.env, otherwise through Claude Code. Correctness is decided by the
checks below, not a judge.
board.json is exported from the running app (window.natter) so it matches the real actions.
"""

import asyncio
import json
import statistics
import time
from pathlib import Path

from dotenv import load_dotenv

from natter_server.resolver import Resolver, has_credentials

HERE = Path(__file__).parent
load_dotenv(HERE.parents[1] / ".env")


def check(expect: dict, result: dict) -> str | None:
    """Return why the result is wrong, or None if it passes."""
    if "kind" in expect:
        if result["kind"] != expect["kind"]:
            return f"expected {expect['kind']}, got {result['kind']}"
        if "reason" in expect and result.get("reason") != expect["reason"]:
            return f"expected reason {expect['reason']}, got {result.get('reason')}"
        return None
    if result["kind"] != "actions":
        return f"expected actions, got {result['kind']} {result.get('reason') or result.get('question') or ''}"
    calls = [c for c in result["calls"] if c["name"] == expect["call"]]
    if not calls:
        return f"no {expect['call']} call in {[c['name'] for c in result['calls']]}"
    call = calls[0]
    if "ids" in expect:
        got = call["input"].get("ids") or [call["input"].get("id")]
        if sorted(got) != sorted(expect["ids"]):
            return f"ids {got}, expected {expect['ids']}"
    for key, value in expect.get("input", {}).items():
        if call["input"].get(key) != value:
            return f"{key}={call['input'].get(key)!r}, expected {value!r}"
    return None


async def main() -> None:
    board = json.loads((HERE / "board.json").read_text())
    cases = json.loads((HERE / "cases.json").read_text())
    resolver = Resolver()
    api = has_credentials()
    print("Claude via the API (ANTHROPIC_API_KEY)" if api else "Claude via Claude Code (no ANTHROPIC_API_KEY), one command at a time")

    async def run(case: dict):
        start = time.perf_counter()
        res = await resolver.resolve(case["say"], board["scene"], board["actions"], case.get("previous"))
        return case, res, (time.perf_counter() - start) * 1000

    if api:
        results = await asyncio.gather(*(run(c) for c in cases))
    else:
        # A Claude Code session answers one command at a time, as in the room.
        resolver.warm_up()
        await asyncio.sleep(5)
        results = [await run(c) for c in cases]
    passed = 0
    times: dict[str, list[float]] = {}
    for case, res, ms in results:
        problem = check(case["expect"], res.result)
        passed += problem is None
        times.setdefault(res.tier, []).append(ms)
        mark = "PASS" if problem is None else "FAIL"
        print(f"{mark}  {res.tier:7} {ms:6.0f}ms  {case['say']!r}" + (f"\n      {problem}" if problem else ""))
    print(f"\n{passed}/{len(cases)} passed")
    for tier, ms in sorted(times.items()):
        print(f"  {tier}: {len(ms)} turns, median {statistics.median(ms):.0f}ms, max {max(ms):.0f}ms")


if __name__ == "__main__":
    asyncio.run(main())
