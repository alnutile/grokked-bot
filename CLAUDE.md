# Working on Grokked Bot

## How changes ship (do this without asking)

The owner wants work to land on main, not wait on them. For every change:

1. Work on a branch (never commit to main directly; this environment can't push to it).
2. Before pushing, run `pnpm typecheck`, `pnpm exec tsc --noEmit` in `apps/desktop`, and
   `pnpm test`. Fix anything red.
3. Push the branch and open a PR (GitHub MCP tools). No human review is needed.
4. Wait for CI (`.github/workflows/ci.yml`: typecheck, tests, UI build, bot computer image
   build). If it's red, fix it and push again.
5. When CI is green, **merge the PR yourself** (rebase merge). That is the end of the change.

What happens on main:
- Every push to main runs CI again.
- A push that changes the version in `apps/desktop/src-tauri/tauri.conf.json` to one with
  no `vX.Y.Z` tag yet runs `release.yml`: Mac dmgs (Apple Silicon, Intel), Linux .deb and
  AppImage, the bot computer image on ghcr.io, the tag, and a **draft** release. The owner
  publishes the draft from the Releases page.

## Cutting a release

When asked for a release (or a feature should reach users), in one PR:
- Bump the version in `apps/desktop/src-tauri/tauri.conf.json`, `apps/desktop/package.json`,
  `container/shim/package.json` and `VERSION` in `packages/daemon/src/config.ts`.
  New feature: minor (0.3.0 -> 0.4.0). Fixes only: patch (0.3.0 -> 0.3.1).
- Replace the "What's new" section at the top of `.github/release-notes.md`, written for
  users, not developers.
- Merge it as above. Merging is what releases it; don't push tags.

Things this environment can't do, so don't try: push to main, push tags, or start a
workflow run (the GitHub app gets 403). If a release needs re-running, ask the owner to
click **Run workflow** on `release` with `main` selected: it releases the current version
if it isn't tagged yet.

## Keep the README current

Any change that adds, removes or renames something a person can do (a tab, a setting, a
tool, an API, an installer) updates the README's **"What it can do"** list in the same PR,
plus the detailed section further down if there is one. The README is how the owner tracks
what the product does.
