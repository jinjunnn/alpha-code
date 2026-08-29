#!/usr/bin/env bash
# REQ-123 / alpha-code#1177 — build the probe bundle and run it inside real Electron.
# Run from packages/ui-mac so the @opencode-ai/app vite plugin and electron resolve.
set -euo pipefail

HARNESS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UI_MAC="$(cd "$HARNESS_DIR/../../../../packages/ui-mac" && pwd)"
OUT="${1:-$HARNESS_DIR/../results/chromium-run.json}"

echo "[1/3] pre-flight: kill any orphan probe electron on CDP/sink port"
STALE="$(lsof -nP -iTCP:38999 -sTCP:LISTEN 2>/dev/null | awk 'NR>1{print $2}' || true)"
for pid in $STALE; do echo "  killing stale listener pid=$pid"; kill -9 "$pid" 2>/dev/null || true; done

echo "[2/3] bundle probe with @opencode-ai/app vite plugin"
# Execute the bundler from inside packages/ui-mac (where vite / @opencode-ai/app resolve).
# Copy build.mjs there so ESM module resolution walks ui-mac/node_modules.
cp "$HARNESS_DIR/build.mjs" "$UI_MAC/.req123-1177-build.mjs"
cp "$HARNESS_DIR/probe-entry.ts" "$UI_MAC/.req123-1177-probe-entry.ts"
trap 'rm -f "$UI_MAC/.req123-1177-build.mjs" "$UI_MAC/.req123-1177-probe-entry.ts"' EXIT
cd "$UI_MAC"
BUNDLE="$(bun "$UI_MAC/.req123-1177-build.mjs" "$UI_MAC/.req123-1177-probe-entry.ts" "$UI_MAC")"
echo "  bundle=$BUNDLE ($(wc -c <"$BUNDLE") bytes)"

echo "[3/3] run in Electron $(./node_modules/.bin/electron --version)"
./node_modules/.bin/electron "$HARNESS_DIR/main.cjs" "$BUNDLE" "$OUT"
echo "  wrote $OUT"
