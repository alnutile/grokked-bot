#!/usr/bin/env bash
# Start (or restart) a bot computer.
set -euo pipefail
export DOCKER_HOST="${DOCKER_HOST:-unix:///run/user/1000/docker.sock}"
NAME="${1:-bot-alpha}"
IMAGE="${IMAGE:-grokked/computer:0.1}"
WORK="$HOME/.local/share/grokked/bots/${NAME}/work"

mkdir -p "$WORK"/{downloads,inbox,out}
docker volume create "${NAME}-profile" >/dev/null

docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" \
  -v "${NAME}-profile:/data/profile" \
  -v "$WORK:/data/work" \
  --shm-size=2g \
  --memory=6g --cpus=3 --pids-limit=1024 \
  --security-opt no-new-privileges \
  -p 127.0.0.1:16080:6080 \
  -p 127.0.0.1:18088:8088 \
  -e TZ="${TZ:-America/New_York}" \
  "$IMAGE" >/dev/null

echo "$NAME started"
echo "  watch:  http://127.0.0.1:16080/vnc.html?autoconnect=1&resize=scale"
echo "  shim:   http://127.0.0.1:18088/health"
echo "  work:   $WORK"
