#!/usr/bin/env bash
# Every bot's screen, with a link that logs straight in.
#   ./vnc.sh            list all bots
#   ./vnc.sh <bot-id>   just that one, and open it in your browser
set -euo pipefail
export DOCKER_HOST="${DOCKER_HOST:-unix:///run/user/$(id -u)/docker.sock}"

names=$(docker ps --filter ancestor=grokked/computer:0.1 --format '{{.Names}}')
[ -n "${1:-}" ] && names="$1"
[ -z "$names" ] && { echo "no bot computers running -- open a bot in the app, or click Restart computer"; exit 1; }

for n in $names; do
  if ! port=$(docker port "$n" 6080/tcp 2>/dev/null | head -1 | cut -d: -f2) || [ -z "$port" ]; then
    echo "$n: not running"; continue
  fi
  pw=$(docker exec "$n" cat /data/profile/.vncpasswd.txt 2>/dev/null || true)
  url="http://127.0.0.1:${port}/vnc.html?autoconnect=1&resize=scale&password=${pw}"
  printf '%s\n  password  %s\n  open      %s\n\n' "$n" "${pw:-(none)}" "$url"
  [ -n "${1:-}" ] && command -v xdg-open >/dev/null && xdg-open "$url" >/dev/null 2>&1 &
done
wait
