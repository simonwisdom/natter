#!/usr/bin/env bash
# Run a recorded Body Lab session through the tracking, once with every fix on and once with
# each fix switched off, and print how steady each run was.
#   scripts/replay.sh lab-recordings/<name>.webm            every fix on, then each one off, then all off
#   scripts/replay.sh <video> "" zoom "zoom,loose"          only these runs (each is a list of fixes to switch off)
#   SECONDS_MAX=60 scripts/replay.sh <video>                only the first minute
# Record a session with V in the Body Lab. Fewer lost hands and fewer short readings is better;
# more hand-frames means hands were kept for longer.
set -euo pipefail
VIDEO="${1:?usage: scripts/replay.sh <video> [fixes to switch off ...]}"
shift || true
[ $# -gt 0 ] || set -- "" steady loose zoom all
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SHOOT="${SHOOT:?set SHOOT to a screenshot tool that takes a URL and prints the --eval result e.g. SHOOT=/path/to/shoot}"
PORT=5199
NAME="$(basename "${VIDEO%.*}" | tr -c 'A-Za-z0-9_\n-' '_')"

# A recording made in the browser has no length or index, so it can't be stepped through. Copy it with both.
mkdir -p "$ROOT/web/public/replay"
ffmpeg -v error -y -i "$VIDEO" -an -c:v copy "$ROOT/web/public/replay/$NAME.webm"

cd "$ROOT/web"
[ -d node_modules ] || npm install
npm run assets >/dev/null
npx vite --host 127.0.0.1 --port "$PORT" --strictPort >/dev/null 2>&1 &
VITE=$!
trap 'kill "$VITE" 2>/dev/null' EXIT
for _ in $(seq 60); do curl -fs -o /dev/null "http://127.0.0.1:$PORT/lab.html" && break; sleep 0.5; done

OUT="$(mktemp -d)"
for off in "$@"; do
  url="http://127.0.0.1:$PORT/lab.html?replay=/replay/$NAME.webm&off=$off&delegate=cpu${SECONDS_MAX:+&seconds=$SECONDS_MAX}"
  result="$("$SHOOT" "$url" --themes dark --widths 1280 --wait '#replay-done' --timeout "${TIMEOUT:-1800}" --out "$OUT" \
    --eval "document.getElementById('replay-done').textContent" 2>&1 | python3 -c '
import json, sys
for line in sys.stdin:
    if line.startswith("result "):
        r = json.loads(json.loads(line.split(": ", 1)[1]))
        r.pop("fixes", None)
        print("  ".join(f"{k} {v}" for k, v in r.items()))
' || true)"
  printf 'off: %-14s %s\n' "${off:-nothing}" "${result:-no result (see $OUT)}"
done
