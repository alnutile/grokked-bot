# Working on Grokked Bot

- **Keep the README's "What it can do" list current.** Any change that adds, removes or
  renames something a person can do (a tab, a setting, a tool, an API, an installer) updates
  that list in the same commit, plus the detailed section further down if there is one.
  The README is how the owner tracks what the product does.
- Before pushing: `pnpm typecheck`, `pnpm exec tsc --noEmit` in `apps/desktop`, `pnpm test`.
  CI (`.github/workflows/ci.yml`) runs the same plus a build of the bot computer image.
- Releases: `git tag vX.Y.Z && git push origin vX.Y.Z` runs `release.yml` (Mac dmgs, Linux
  .deb and AppImage, the bot computer image on ghcr.io) and opens a draft release.
