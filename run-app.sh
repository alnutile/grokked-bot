#!/usr/bin/env bash
# Start everything and open the app.
set -euo pipefail
cd "$(dirname "$0")"
export DOCKER_HOST="${DOCKER_HOST:-unix:///run/user/1000/docker.sock}"

systemctl --user start docker.service grokked.service
echo "daemon:  $(systemctl --user is-active grokked)"

# Each bot's computer is started by the daemon on demand (or "Restart computer").

exec apps/desktop/build.sh dev
