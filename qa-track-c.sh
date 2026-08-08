#!/bin/bash
# Track C.2 on-screen checklist runner. Starts the daemon against a SEEDED
# COPY of the real vault (/tmp/q2v-c2), on a separate port, with its own
# token — completely isolated from ./start.sh and your production vault.
#
# Usage:
#   ./qa-track-c.sh          start the QA daemon + app (full window)
#   ./qa-track-c.sh --stop
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

PORT=4499
VAULT=/tmp/q2v-c2
TOKEN=qatoken
APP="desktop/build/macos/Build/Products/Release/quick2avault_desktop.app"
BIN="$APP/Contents/MacOS/quick2avault_desktop"
BUNDLE_ID="in.thecontrarian.quick2avaultDesktop"
FLUTTER_BIN="${FLUTTER_BIN:-$HOME/flutter-sdk/bin}"
[ -d "$FLUTTER_BIN" ] && export PATH="$PATH:$FLUTTER_BIN"

if [ "${1:-}" = "--stop" ]; then
  for p in $(pgrep -f "quick2avault_desktop" 2>/dev/null || true); do kill -9 "$p"; done
  P=$(lsof -tiTCP:$PORT -sTCP:LISTEN 2>/dev/null || true)
  [ -n "$P" ] && kill -9 "$P"
  echo "stopped."
  exit 0
fi

echo "Re-seeding $VAULT from the real vault (fresh copy every run)..."
rm -rf "$VAULT" && mkdir -p "$VAULT"
node -e "
const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync('/Users/home/Documents/Quick2AVault/vault.db',{readOnly:true});
db.exec(\"VACUUM INTO '$VAULT/vault.db'\"); db.close();
"

echo "Starting the QA daemon on :$PORT ..."
Q2AV_VAULT="$VAULT" Q2AV_PORT="$PORT" Q2AV_TOKEN="$TOKEN" \
  nohup npx tsx daemon/main.ts > /tmp/q2v-c2-daemon.log 2>&1 &

for i in $(seq 1 40); do
  curl -sf --max-time 2 -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT/v1/health" >/dev/null 2>&1 && break
  sleep 0.5
done

echo "Building the app against the QA daemon (full window, so no tray click needed)..."
( cd desktop && flutter build macos --release \
    --dart-define=Q2AV_TOKEN="$TOKEN" \
    --dart-define=Q2AV_URL="http://127.0.0.1:$PORT" \
    --dart-define=Q2AV_START_FULL=true >/dev/null )

nohup "$BIN" > /tmp/q2v-c2-app.log 2>&1 &
sleep 3
open -b "$BUNDLE_ID" 2>/dev/null || true

echo
echo "QA daemon+app running against a THROWAWAY copy — your real vault is untouched."
echo "Reset/delete freely; re-run this script any time to get a fresh copy back."
echo
echo "NOTE: this rebuilds the shared desktop/build output against the QA token."
echo "./start.sh detects the token mismatch and rebuilds automatically next time"
echo "you run it — no manual cleanup needed, but expect one extra ~20s build."
echo
echo "Stop with: ./qa-track-c.sh --stop"
