#!/usr/bin/env bash
set -euo pipefail
mkdir -p /data/profile /data/work/downloads /data/work/inbox /data/work/out /var/log/grokked

# One-time VNC password so x11vnc is never open to whoever can reach the port.
if [ ! -f /data/profile/.vncpasswd ]; then
  pw="${VNC_PASSWORD:-$(head -c 12 /dev/urandom | base64 | tr -d '/+=' | head -c 12)}"
  x11vnc -storepasswd "$pw" /data/profile/.vncpasswd >/dev/null 2>&1
  echo "$pw" > /data/profile/.vncpasswd.txt
  chmod 600 /data/profile/.vncpasswd.txt
fi
exec "$@"
