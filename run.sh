#!/usr/bin/env bash
# Start Natter.
#   ./run.sh           build the web app and serve everything at http://127.0.0.1:8777
#   ./run.sh dev       Vite dev server with hot reload at http://localhost:5173 (plus the Python server)
#   ./run.sh install   run it as a background service that starts at login and restarts if it crashes
#   ./run.sh restart   rebuild the web app and restart the service, to pick up code changes
#   ./run.sh stop      stop the service and stop it starting at login
#   ./run.sh phone     share it over HTTPS to your own devices with Tailscale (`./run.sh phone off` stops sharing)
# The server rereads .env by itself, so adding an API key needs no restart.
set -euo pipefail
cd "$(dirname "$0")"
LABEL=com.natter.server
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
# The service used to have another name; remove it so two copies never run.
OLD_LABEL=com.wisdom.gesture-room
OLD_PLIST="$HOME/Library/LaunchAgents/$OLD_LABEL.plist"

[ -d web/node_modules ] || (cd web && npm install)

unload() {
  launchctl bootout "gui/$UID/$LABEL" >/dev/null 2>&1 || true
  # bootout returns before the job is gone, and bootstrap fails while it's still there.
  for _ in $(seq 40); do launchctl print "gui/$UID/$LABEL" >/dev/null 2>&1 || break; sleep 0.25; done
}

remove_old() {
  launchctl bootout "gui/$UID/$OLD_LABEL" >/dev/null 2>&1 || true
  rm -f "$OLD_PLIST"
}

wait_up() {
  for _ in $(seq 60); do
    curl -fs -o /dev/null http://127.0.0.1:8777/ && { echo "Natter: running at http://127.0.0.1:8777"; return; }
    sleep 0.5
  done
  echo "Natter did not come up; see ~/Library/Logs/natter.log" >&2
  exit 1
}

case "${1:-}" in
  dev)
    (cd server && uv run natter-server) &
    trap 'kill %1 2>/dev/null' EXIT
    cd web && npm run dev
    ;;
  install)
    (cd web && npm run build)
    sed -e "s|__HOME__|$HOME|g" -e "s|__DIR__|$PWD|g" "launchd/$LABEL.plist.in" > "$PLIST"
    plutil -lint "$PLIST" >/dev/null
    remove_old
    unload
    launchctl bootstrap "gui/$UID" "$PLIST"
    wait_up
    ;;
  restart)
    (cd web && npm run build)
    launchctl kickstart -k "gui/$UID/$LABEL"
    wait_up
    ;;
  stop)
    remove_old
    unload
    rm -f "$PLIST"
    echo "Natter: stopped"
    ;;
  phone)
    command -v tailscale >/dev/null || { echo "Install Tailscale first: https://tailscale.com/download" >&2; exit 1; }
    if [ "${2:-}" = off ]; then
      tailscale serve --https=443 off
      echo "Natter: no longer shared"
      exit
    fi
    # Safari only allows the camera and mic over HTTPS; Tailscale gives this Mac a trusted certificate
    # and an address only your own devices can open. The server itself stays on 127.0.0.1.
    tailscale serve --bg --https=443 http://127.0.0.1:8777
    host=$(tailscale status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')
    echo "Natter: open https://$host on your iPhone (signed in to the same Tailscale account)"
    ;;
  "")
    (cd web && npm run build)
    echo "Natter: open http://127.0.0.1:8777 in Chrome"
    cd server && exec uv run natter-server
    ;;
  *)
    echo "usage: ./run.sh [dev|install|restart|stop]" >&2
    exit 2
    ;;
esac
