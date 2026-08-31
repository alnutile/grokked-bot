#!/usr/bin/env bash
# Start everything and open the app.
set -euo pipefail
cd "$(dirname "$0")"
export DOCKER_HOST="${DOCKER_HOST:-unix:///run/user/1000/docker.sock}"

systemctl --user start docker.service grokked.service
echo "daemon:  $(systemctl --user is-active grokked)"

# Bring the bot's computer up if it isn't (the app can also do this itself).
if ! docker inspect -f '{{.State.Status}}' bot-alpha 2>/dev/null | grep -q running; then
  echo "starting bot-alpha…"
  container/run.sh bot-alpha >/dev/null
fi
echo "computer: $(docker inspect -f '{{.State.Status}}' bot-alpha)"

exec apps/desktop/build.sh dev
