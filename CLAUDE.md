# Working on Grokked Bot

- **Keep the README's "What it can do" list current.** Any change that adds, removes or
  renames something a person can do (a tab, a setting, a tool, an API, an installer) updates
  that list in the same commit, plus the detailed section further down if there is one.
  The README is how the owner tracks what the product does.
- Before pushing: `pnpm typecheck`, `pnpm exec tsc --noEmit` in `apps/desktop`, `pnpm test`.
  CI (`.github/workflows/ci.yml`) runs the same plus a build of the bot computer image.
- Releases: bump the version (`apps/desktop/src-tauri/tauri.conf.json`, `apps/desktop/package.json`,
  `container/shim/package.json`, `VERSION` in `packages/daemon/src/config.ts`), put the
  "What's new" section in `.github/release-notes.md`, and merge that to main. `release.yml`
  then builds the Mac dmgs, the Linux .deb and AppImage and the bot computer image, tags
  `vX.Y.Z` and opens a draft release for the owner to publish.
