#!/usr/bin/env bash
set -euo pipefail

mkdir -p "$PROFILE_DIR" "$WORK_DIR/downloads" "$WORK_DIR/inbox" "$WORK_DIR/out"

# Exactly one Chrome may own a user-data-dir. If supervisord restarts us before
# the previous process fully died, a stale lock makes Chrome fail to start with
# no useful message.
rm -f "$PROFILE_DIR"/Singleton* 2>/dev/null || true

exec google-chrome \
  --user-data-dir="$PROFILE_DIR" \
  --remote-debugging-port="${CDP_PORT}" \
  --remote-debugging-address=127.0.0.1 \
  --password-store=basic \
  --no-first-run --no-default-browser-check --no-service-autorun \
  --disable-session-crashed-bubble --hide-crash-restore-bubble \
  --window-position=0,0 \
  --window-size="${SCREEN_WIDTH},${SCREEN_HEIGHT}" \
  --force-device-scale-factor=1 \
  --lang=en-US \
  --use-gl=swiftshader \
  --no-sandbox \
  --disable-infobars \
  --disable-background-timer-throttling \
  --disable-backgrounding-occluded-windows \
  --disable-renderer-backgrounding \
  --disable-features=Translate,MediaRouter,DialMediaRouteProvider,OptimizationHints,AcceptCHFrame,CalculateNativeWinOcclusion,InterestFeedContentSuggestions \
  about:blank
