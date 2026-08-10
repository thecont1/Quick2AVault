#!/usr/bin/env bash
#
# Start Quick2AVault: daemon + desktop app, one command.
#
#   ./start.sh              start both, build the app only if needed
#   ./start.sh --full       start in the full window instead of the popup
#   ./start.sh --rebuild    force a fresh app build
#   ./start.sh --daemon     daemon only (no GUI)
#   ./start.sh --stop       stop everything
#   ./start.sh --status     what is running
#
# THE TOKEN PROBLEM THIS SOLVES
#
# The daemon mints a random token per boot, but the Flutter client bakes its
# token in at BUILD time (--dart-define). Left alone that means a rebuild after
# every daemon restart. So the token is generated once, stored in .q2av-token
# (gitignored, chmod 600), and reused: the daemon is told to use it, the app is
# built against it, and a restart of either side keeps working.
#
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

PORT="${Q2AV_PORT:-4477}"
TOKEN_FILE=".q2av-token"
LOG_DIR=".logs"
APP="desktop/build/macos/Build/Products/Release/quick2avault_desktop.app"
BIN="$APP/Contents/MacOS/quick2avault_desktop"
MODE_FILE=".build-mode"
START_FULL=""   # set by --full; opens the big window instead of the popup
mode() { [ -n "$START_FULL" ] && echo full || echo popup; }
BUNDLE_ID="in.thecontrarian.quick2avaultDesktop"
FLUTTER_BIN="${FLUTTER_BIN:-$HOME/flutter-sdk/bin}"
[ -d "$FLUTTER_BIN" ] && export PATH="$PATH:$FLUTTER_BIN"

green() { printf '\033[32m%s\033[0m\n' "$1"; }
dim()   { printf '\033[2m%s\033[0m\n'  "$1"; }
warn()  { printf '\033[33m%s\033[0m\n' "$1"; }
die()   { printf '\033[31m%s\033[0m\n' "$1" >&2; exit 1; }

daemon_pids() { pgrep -f "daemon/main.ts" 2>/dev/null || true; }
app_pids()    { pgrep -f "quick2avault_desktop" 2>/dev/null || true; }
port_pids()   { lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true; }

ensure_token() {
  if [ ! -f "$TOKEN_FILE" ]; then
    openssl rand -hex 16 > "$TOKEN_FILE"
    chmod 600 "$TOKEN_FILE"
    dim "  minted a new token -> $TOKEN_FILE"
  fi
  TOKEN="$(tr -d '[:space:]' < "$TOKEN_FILE")"
  [ -n "$TOKEN" ] || die "token file is empty; delete $TOKEN_FILE and re-run"
}

stop_all() {
  local killed=0
  for p in $(app_pids);    do kill -9 "$p" 2>/dev/null && killed=1; done
  for p in $(daemon_pids); do kill    "$p" 2>/dev/null && killed=1; done
  sleep 2
  # A daemon that ignored SIGTERM still holds the port; take it by force.
  for p in $(port_pids); do kill -9 "$p" 2>/dev/null; done
  [ "$killed" = 1 ] && green "stopped." || dim "nothing was running."
}

status() {
  local d a
  d="$(daemon_pids | tr '\n' ' ')"; a="$(app_pids | tr '\n' ' ')"
  printf '  daemon   %s\n' "${d:-not running}"
  printf '  app      %s\n' "${a:-not running}"
  printf '  port     %s\n' "$(port_pids | tr '\n' ' ' || echo free)"
  if [ -n "$d" ] && [ -f "$TOKEN_FILE" ]; then
    printf '  health   '
    curl -s --max-time 3 -H "Authorization: Bearer $(cat $TOKEN_FILE)" \
      "http://127.0.0.1:$PORT/v1/health" || printf 'no response'
    printf '\n'
  fi
}

start_daemon() {
  if [ -n "$(port_pids)" ]; then
    # Reuse only if it answers with OUR token; a foreign listener is a conflict.
    if curl -sf --max-time 3 -H "Authorization: Bearer $TOKEN" \
         "http://127.0.0.1:$PORT/v1/health" >/dev/null 2>&1; then
      green "daemon already running on :$PORT"
      return
    fi
    die "port $PORT is held by another process that does not accept our token.
Run './start.sh --stop' first, or set Q2AV_PORT to something else."
  fi

  mkdir -p "$LOG_DIR"
  Q2AV_TOKEN="$TOKEN" Q2AV_PORT="$PORT" \
    nohup bunx tsx daemon/main.ts > "$LOG_DIR/daemon.log" 2>&1 &

  # Poll for readiness instead of sleeping a fixed guess.
  local i
  for i in $(seq 1 40); do
    if curl -sf --max-time 2 -H "Authorization: Bearer $TOKEN" \
         "http://127.0.0.1:$PORT/v1/health" >/dev/null 2>&1; then
      green "daemon up on :$PORT"
      return
    fi
    sleep 0.5
  done
  warn "daemon did not become healthy in 20s. Last log lines:"
  tail -20 "$LOG_DIR/daemon.log" >&2
  exit 1
}

build_app() {
  green "cleaning previous build artifacts…"
  command -v flutter >/dev/null || die "flutter not on PATH. Set FLUTTER_BIN=/path/to/flutter/bin"
  ( cd desktop && flutter clean >/dev/null ) || die "flutter clean failed"
  green "building the desktop app (~60s)…"
  # Q2AV_START_FULL is a QA aid, not the product default: the menubar popup is
  # the intended entry point. Only bake it in when --full was asked for.
  ( cd desktop && flutter build macos --release \
      --dart-define=Q2AV_TOKEN="$TOKEN" \
      --dart-define=Q2AV_URL="http://127.0.0.1:$PORT" \
      ${START_FULL:+--dart-define=Q2AV_START_FULL=true} >/dev/null ) \
    || die "flutter build failed. Run it manually in desktop/ to see why."
  # Record what this binary was built WITH. The token cannot be detected by
  # grepping the executable: --dart-define values are compiled into the AOT
  # snapshot (App.framework), not the launcher binary.
  printf '%s\n%s\n' "$(mode)" "$TOKEN" > "$MODE_FILE"
  # Print build identity so you can verify you're not looking at a stale binary.
  local sha ts
  sha="$(git rev-parse --short HEAD 2>/dev/null || echo 'unknown')"
  ts="$(date '+%Y-%m-%d %H:%M:%S')"
  green "build complete: $sha  $ts"
}

# Rebuild when the binary is missing, older than the Dart sources, or built
# against a different token. Without the token check a stale binary silently
# fails auth and the window shows an empty vault.
needs_build() {
  [ -x "$BIN" ] || return 0
  [ -n "$(find desktop/lib -name '*.dart' -newer "$BIN" -print -quit 2>/dev/null)" ] && return 0
  # .build-mode holds two lines: the window mode, then the token the binary was
  # built against. Either changing means the current binary is stale.
  [ -f "$MODE_FILE" ] || return 0
  [ "$(sed -n 1p "$MODE_FILE")" = "$(mode)" ] || return 0
  [ "$(sed -n 2p "$MODE_FILE")" = "$TOKEN" ]  || return 0
  return 1
}

start_app() {
  # Check freshness BEFORE the already-running shortcut. A running app built in
  # the other window mode (or against an older token) must be replaced, not
  # merely raised — otherwise './start.sh --full' silently keeps the popup.
  if needs_build; then
    [ -n "$(app_pids)" ] && { dim "  rebuilding — stopping the running app"; for p in $(app_pids); do kill -9 "$p" 2>/dev/null; done; sleep 1; }
    build_app
  elif [ -n "$(app_pids)" ]; then
    green "app already running — bringing it to front"
    open -b "$BUNDLE_ID" 2>/dev/null || true
    return
  fi
  mkdir -p "$LOG_DIR"
  nohup "$BIN" > "$LOG_DIR/app.log" 2>&1 &
  sleep 3
  open -b "$BUNDLE_ID" 2>/dev/null || true
  green "app launched"
}

# --full may be combined with the default start or with --rebuild.
ARGS=()
for a in "$@"; do
  case "$a" in
    --full) START_FULL=1 ;;
    *) ARGS+=("$a") ;;
  esac
done
set -- "${ARGS[@]+"${ARGS[@]}"}"

case "${1:-}" in
  --stop)   stop_all; exit 0 ;;
  --status) status;   exit 0 ;;
  --daemon) ensure_token; start_daemon; echo; status; exit 0 ;;
  --rebuild)
    ensure_token
    start_daemon
    build_app
    start_app
    ;;
  --help|-h)
    sed -n '3,12p' "$0" | sed 's/^# \{0,1\}//'
    exit 0 ;;
  "")
    ensure_token
    start_daemon
    start_app
    ;;
  *) die "unknown option: $1  (try --help)" ;;
esac

echo
status
echo
dim "  logs:  $LOG_DIR/daemon.log  $LOG_DIR/app.log"
dim "  stop:  ./start.sh --stop"
