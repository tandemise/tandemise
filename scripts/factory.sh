#!/bin/sh
# The local factory that builds Tandemise with Tandemise (docs/FACTORY-DOGFOOD.md).
#
#   scripts/factory.sh start      start the newest AppImage in $FACTORY_HOME/app (its daemon starts with it)
#   scripts/factory.sh stop       quit the window; the daemon keeps running (add --daemon to stop it too)
#   scripts/factory.sh status     what is running, which release, where the API and CDP are
#   scripts/factory.sh upgrade    download the latest release into app/, stop everything, start the new one
#   scripts/factory.sh api METHOD PATH [JSON]   call the daemon's HTTP API with its token
#
# Everything lives in FACTORY_HOME (default ~/.tandemise-factory), which is the
# instance's TANDEMISE_HOME. It never reads or writes ~/.tandemise.
set -eu

FACTORY_HOME="${FACTORY_HOME:-$HOME/.tandemise-factory}"
APP_DIR="$FACTORY_HOME/app"
REPO="${FACTORY_REPO:-tandemise/tandemise}"
LOG_DIR="$FACTORY_HOME/logs"
CDP_FILE="$FACTORY_HOME/cdp-port"
PID_FILE="$FACTORY_HOME/app.pid"

newest_appimage() {
  ls -1t "$APP_DIR"/Tandemise-*-linux-x86_64.AppImage 2>/dev/null | head -n 1
}

daemon_field() {
  # daemon_field url|pid|version|token
  [ -f "$FACTORY_HOME/daemon.json" ] || return 1
  node -e 'const d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); process.stdout.write(String(d[process.argv[2]] ?? ""))' "$FACTORY_HOME/daemon.json" "$1"
}

alive() { [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null; }

port_free() {
  ! (ss -ltn 2>/dev/null | grep -q "127.0.0.1:$1 ")
}

app_pid() {
  [ -f "$PID_FILE" ] || return 1
  pid=$(cat "$PID_FILE")
  alive "$pid" && echo "$pid"
}

start() {
  if pid=$(app_pid); then echo "already running (pid $pid, CDP $(cat "$CDP_FILE"))"; return 0; fi
  image=$(newest_appimage)
  [ -n "$image" ] || { echo "no AppImage in $APP_DIR; run: $0 upgrade" >&2; exit 1; }
  mkdir -p "$LOG_DIR"
  # The daemon the app starts inherits the window's DevTools socket, so after a
  # restart the old port can still be taken: use the first free one.
  port=${FACTORY_CDP_PORT:-9371}
  while ! port_free "$port"; do port=$((port + 1)); done
  echo "$port" > "$CDP_FILE"
  TANDEMISE_HOME="$FACTORY_HOME" NO_CLEANUP=1 nohup "$image" \
    --remote-debugging-port="$port" --user-data-dir="$FACTORY_HOME/electron" \
    >> "$LOG_DIR/app.log" 2>&1 &
  echo $! > "$PID_FILE"
  echo "started $(basename "$image") (pid $!), CDP on 127.0.0.1:$port, TANDEMISE_HOME=$FACTORY_HOME"
}

stop() {
  if pid=$(app_pid); then
    kill "$pid" 2>/dev/null || true
    # The AppImage runtime is the recorded pid; the window is its child.
    pkill -TERM -P "$pid" 2>/dev/null || true
    echo "window stopped (pid $pid)"
  else
    echo "window not running"
  fi
  rm -f "$PID_FILE"
  if [ "${1:-}" = "--daemon" ]; then
    dpid=$(daemon_field pid || true)
    if alive "$dpid"; then kill "$dpid"; echo "daemon stopped (pid $dpid)"; else echo "daemon not running"; fi
  fi
}

status() {
  echo "home:    $FACTORY_HOME"
  echo "app:     $(newest_appimage || echo none)"
  if pid=$(app_pid); then echo "window:  running (pid $pid), CDP 127.0.0.1:$(cat "$CDP_FILE")"; else echo "window:  not running"; fi
  dpid=$(daemon_field pid || true)
  if alive "$dpid"; then
    echo "daemon:  running (pid $dpid), version $(daemon_field version), $(daemon_field url)"
  else
    echo "daemon:  not running"
  fi
}

upgrade() {
  mkdir -p "$APP_DIR"
  gh release download --repo "$REPO" --pattern "*-linux-x86_64.AppImage" --dir "$APP_DIR" --skip-existing
  chmod +x "$APP_DIR"/*.AppImage
  echo "newest: $(newest_appimage)"
  # The app replaces an older daemon itself when it starts, and says so.
  stop
  start
}

api() {
  url=$(daemon_field url) || { echo "daemon not running" >&2; exit 1; }
  token=$(daemon_field token)
  if [ $# -ge 3 ]; then
    curl -sS -X "$1" -H "authorization: Bearer $token" -H "x-tandemise-api-version: v1" -H "content-type: application/json" --data "$3" "$url$2"
  else
    curl -sS -X "$1" -H "authorization: Bearer $token" -H "x-tandemise-api-version: v1" "$url$2"
  fi
  echo
}

cmd="${1:-status}"
[ $# -gt 0 ] && shift
case "$cmd" in
  start) start ;;
  stop) stop "$@" ;;
  status) status ;;
  upgrade) upgrade ;;
  api) api "$@" ;;
  *) echo "usage: $0 start|stop [--daemon]|status|upgrade|api METHOD PATH [JSON]" >&2; exit 2 ;;
esac
