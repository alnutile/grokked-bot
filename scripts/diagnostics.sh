#!/usr/bin/env bash
# Grokked Bot diagnostics: what's installed, what's running, and the recent log,
# with tokens and keys scrubbed out. Writes grokked-diagnostics.txt to the Desktop
# (or home) so it can be sent to whoever is helping.
#
#   curl -fsSL https://raw.githubusercontent.com/alnutile/grokked-bot/main/scripts/diagnostics.sh | bash
set -uo pipefail

if [ "$(uname)" = Darwin ]; then
  DIR="$HOME/Library/Application Support/Grokked"; PORT=8787
  APP_VERSION=$(defaults read "/Applications/Grokked Bot.app/Contents/Info" CFBundleShortVersionString 2>/dev/null || echo "not in /Applications")
else
  DIR="${XDG_CONFIG_HOME:-$HOME/.config}/grokked-app"; PORT=8797
  APP_VERSION=$(dpkg-query -W -f='${Version}' grokked-bot 2>/dev/null || echo unknown)
fi
DIR="${GROKKED_CONFIG_DIR:-$DIR}"; PORT="${GROKKED_PORT:-$PORT}"   # for a second instance
OUT="$HOME/Desktop/grokked-diagnostics.txt"; [ -d "$HOME/Desktop" ] || OUT="$HOME/grokked-diagnostics.txt"
OUT="${GROKKED_DIAG_OUT:-$OUT}"
TOKEN=$(cat "$DIR/token" 2>/dev/null || true)
api() { curl -s -m 5 -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT$1" 2>/dev/null || echo '(no answer)'; }

# Anything shaped like a secret becomes [redacted].
scrub() {
  sed -E \
    -e 's/xox[abpre]-[A-Za-z0-9-]+/[redacted-slack]/g' \
    -e 's/xapp-[A-Za-z0-9-]+/[redacted-slack]/g' \
    -e 's/sk-or-[A-Za-z0-9-]+/[redacted-openrouter]/g' \
    -e 's/sk-[A-Za-z0-9_-]{20,}/[redacted-key]/g' \
    -e 's/(gh[pousr]_|github_pat_)[A-Za-z0-9_]+/[redacted-github]/g' \
    -e 's/(Bearer|bearer|token|password|secret)([" :=]+)[^" ,}]+/\1\2[redacted]/g' \
    -e 's/-----BEGIN [A-Z ]*PRIVATE KEY-----.*/[redacted-private-key]/g'
}

{
  echo "== Grokked Bot diagnostics, $(date)"
  echo "app version:   $APP_VERSION (service: $(api /v1/health | sed -E 's/.*"version":"([^"]+)".*/\1/'))"
  echo "system:        $(uname -sm) $( [ "$(uname)" = Darwin ] && sw_vers -productVersion)"
  echo "memory:        $( [ "$(uname)" = Darwin ] && echo "$(( $(sysctl -n hw.memsize) / 1073741824 )) GB" || free -h | awk '/Mem:/{print $2}')"
  echo
  echo "== Docker"
  if command -v docker >/dev/null; then
    docker version --format 'client {{.Client.Version}}, server {{.Server.Version}}' 2>&1 | head -1
    docker info --format 'memory for containers: {{.MemTotal}} bytes, CPUs: {{.NCPU}}' 2>&1 | head -1
    docker ps -a --format '{{.Names}}  {{.Image}}  {{.Status}}' 2>&1 | grep -i grokked || echo "(no bot computers yet)"
    docker images --format '{{.Repository}}:{{.Tag}}  {{.Size}}' 2>&1 | grep -i grokked
  else
    echo "docker: not found on PATH"
  fi
  echo
  echo "== The app's background service (port $PORT)"
  echo "health: $(api /v1/health)"
  echo "system: $(api /v1/system)"
  echo
  echo "== Bots"
  BOTS=$(api /v1/bots)
  echo "$BOTS" | python3 -c '
import sys, json
try:
  for b in json.load(sys.stdin)["bots"]: print(b["id"], "|", b["name"], "| model:", b.get("model") or "default")
except Exception as e: print("(could not read bots)")' 2>/dev/null
  for id in $(echo "$BOTS" | python3 -c 'import sys,json; print(" ".join(b["id"] for b in json.load(sys.stdin)["bots"]))' 2>/dev/null); do
    echo "-- $id slack: $(api "/v1/bots/$id/slack" | python3 -c '
import sys, json
try:
  d = json.load(sys.stdin)
  print("connected to %s as @%s, status %s %s, allow_all=%s, people=%d" % (d["team_name"], d["bot_user_name"], d["status"]["state"], d["status"].get("detail") or "", d["allow_all"], len(d["allowed_users"]))) if d["configured"] else print("not set up")
except Exception: print("(n/a)")' 2>/dev/null)"
  done
  echo
  echo "== Recent runs"
  api "/v1/runs" | python3 -c '
import sys, json
try:
  d = json.load(sys.stdin); runs = d.get("runs", d)
  for r in runs[:15]: print(r["id"], r["state"], (r.get("state_reason") or "")[:80], "| steps", r.get("step_no"), "| $%.3f" % (r.get("spend_usd") or 0))
except Exception: print("(could not read runs)")' 2>/dev/null
  echo
  echo "== Last 300 lines of the log ($DIR/daemon.log)"
  tail -n 300 "$DIR/daemon.log" 2>/dev/null || echo "(no log file)"
} 2>&1 | scrub > "$OUT"

echo "Wrote $OUT"
echo "Secrets (Slack, OpenRouter, GitHub tokens, keys) are replaced with [redacted]. Skim it, then send it over."
