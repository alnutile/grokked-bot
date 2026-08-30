# Grokked Bot

An always-on AI teammate that runs on Linux: you chat with it, and it reaches for its
own computer — a container with a real browser — when a task needs one.

Three processes:

```
Tauri app  ──HTTP/WS──▶  daemon (systemd --user)  ──Docker API──▶  bot container
 React UI                Node 24 + SQLite                          Xvfb + Chrome + shim
```

The agent loop lives in the **daemon**, never in the container: the OpenRouter key stays
out of the untrusted-content zone, models swap without rebuilding a 2GB image, and
transcripts stay on the host. The container is a generic, replaceable "computer" behind a
typed action API — which is also what makes moving the daemon to a remote always-on box a
base-URL change rather than a rewrite.

## Status

**M0 complete** — daemon, schema, HTTP + WS with durable event replay, systemd unit.
See `docs/PLAN.md` for the full milestone list.

## Setup

Requires Node 24+ (runs TypeScript natively) and rootless Docker. Neither needs root.

```bash
dockerd-rootless-setuptool.sh install    # -> unix:///run/user/1000/docker.sock
loginctl enable-linger "$USER"           # survive logout/reboot; no root needed
pnpm install

cp packages/daemon/deploy/grokked.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now grokked.service
```

Put your key in `~/.config/grokked/env` (mode 0600):

```
OPENROUTER_API_KEY=sk-or-...
```

Then:

```bash
curl -H "Authorization: Bearer $(cat ~/.config/grokked/token)" \
     http://127.0.0.1:8787/v1/health
journalctl --user -u grokked -f
```

Use **rootless** Docker rather than adding yourself to the `docker` group: that group is
effectively root (`docker run -v /:/host`), a poor trade for a system whose job is holding
live credentials.

## Layout

| Path | What |
|---|---|
| `packages/protocol` | Zod schemas shared by daemon and UI — change one, the other fails typecheck |
| `packages/daemon` | HTTP + WS, SQLite, agent loop, tool registry, Docker runtime |
| `packages/daemon/src/db/migrations` | Schema. Everything is downstream of `001_init.sql` |
| `container` | Bot computer image: Xvfb + openbox + Chrome + x11vnc + CDP shim |
| `apps/desktop` | Tauri v2 + React client |

## Paths

```
~/.config/grokked/env       OPENROUTER_API_KEY   (0600)
~/.config/grokked/token     API bearer token     (0600, generated on first boot)
~/.local/share/grokked/     grokked.db + blobs/
/run/user/1000/grokked/     daemon.json discovery file
```

## Design notes worth knowing before you change things

- **The daemon holds no run state that is not in SQLite.** One code path serves start,
  resume-after-crash, resume-after-approval and wake-from-sleep. Never add a second one.
- **The WS is a cache-invalidation channel, not the source of truth.** Every frame is
  appended to `events` first so `?since=` replay can rebuild client state; a client whose
  `since` predates retention gets `hello{dropped:true}` and must refetch.
- **Browser control is DOM/CDP-based, not pixel coordinates.** OpenRouter exposes plain
  OpenAI-style function calling, with no access to a computer-use-tuned model, so the agent
  picks a `ref` from an accessibility snapshot rather than guessing an `(x, y)`. Refs are
  generation-scoped, so acting on a stale one is a hard error instead of a wrong click.

## Tests

```bash
node packages/daemon/test/ws-replay.test.ts
```
