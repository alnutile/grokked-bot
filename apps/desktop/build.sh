#!/usr/bin/env bash
# System GTK/WebKit dev packages are present on this machine (webkit2gtk-4.1
# 2.52.3), so unlike the sibling screenshooter project this needs no local-deps
# tree. If pkg-config ever stops finding them, point PKG_CONFIG_PATH at one.
set -euo pipefail
cd "$(dirname "$0")"
command -v cargo >/dev/null || source "$HOME/.cargo/env"

case "${1:-dev}" in
  dev)   pnpm tauri dev ;;
  build) pnpm tauri build ;;
  check) cd src-tauri && cargo check ;;
  *) echo "usage: $0 {dev|build|check}"; exit 1 ;;
esac
