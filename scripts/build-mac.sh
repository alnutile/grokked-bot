#!/usr/bin/env bash
# Build the .dmg on a Mac. CI does the same thing in .github/workflows/release.yml.
#   scripts/build-mac.sh                      # this Mac's architecture
#   scripts/build-mac.sh x86_64-apple-darwin  # Intel build from an Apple Silicon Mac
set -euo pipefail
cd "$(dirname "$0")/.."
TARGET="${1:-$(rustc -vV | sed -n 's/^host: //p')}"
rustup target add "$TARGET" >/dev/null
pnpm install
node scripts/build.mjs
scripts/fetch-node.sh "$TARGET"
(cd apps/desktop && pnpm tauri build --target "$TARGET" --bundles app,dmg)
ls -1 apps/desktop/src-tauri/target/"$TARGET"/release/bundle/dmg/*.dmg
