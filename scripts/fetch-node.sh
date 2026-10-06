#!/usr/bin/env bash
# Put a Node binary where Tauri expects the "node" sidecar:
#   apps/desktop/src-tauri/binaries/node-<rust target triple>
# The macOS app runs the daemon on this, so users don't need Node installed.
set -euo pipefail
cd "$(dirname "$0")/.."

NODE_VERSION="${NODE_VERSION:-24.19.0}"
TRIPLE="${1:-$(rustc -vV | sed -n 's/^host: //p')}"

case "$TRIPLE" in
  aarch64-apple-darwin)      DIST="darwin-arm64" ;;
  x86_64-apple-darwin)       DIST="darwin-x64" ;;
  x86_64-unknown-linux-gnu)  DIST="linux-x64" ;;
  aarch64-unknown-linux-gnu) DIST="linux-arm64" ;;
  *) echo "no Node build for $TRIPLE" >&2; exit 1 ;;
esac

OUT="apps/desktop/src-tauri/binaries/node-$TRIPLE"
if [[ -x "$OUT" ]] && [[ "$("$OUT" -v 2>/dev/null || true)" == "v$NODE_VERSION" ]]; then
  echo "have $OUT"; exit 0
fi

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
NAME="node-v$NODE_VERSION-$DIST"
BASE="https://nodejs.org/dist/v$NODE_VERSION"
curl -fsSL "$BASE/$NAME.tar.gz" -o "$TMP/node.tgz"
curl -fsSL "$BASE/SHASUMS256.txt" -o "$TMP/SHASUMS256.txt"
(cd "$TMP" && grep " $NAME.tar.gz\$" SHASUMS256.txt | sed "s|$NAME.tar.gz|node.tgz|" | shasum -a 256 -c -)
tar -xzf "$TMP/node.tgz" -C "$TMP" "$NAME/bin/node"
mkdir -p "$(dirname "$OUT")"
mv "$TMP/$NAME/bin/node" "$OUT"
chmod +x "$OUT"
echo "wrote $OUT ($NODE_VERSION, $DIST)"
