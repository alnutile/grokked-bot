# Grokked Bot

**An open-source AI teammate that runs on your own Linux box.** Powered by
[OpenRouter](https://openrouter.ai), so you pick the model. Inspired by Grok Bot and
Claude Cowork — the difference is that the "computer" your agent works on is a container
on hardware you already own, not a cloud VM you rent.

![The app: bot list, the conversation, and the bot's live screen](docs/img/grokked-bot.png)

You message a bot like a colleague. It has **its own computer** — a real desktop with a
real browser it stays logged into, plus a shell — and it uses whichever fits the job. You
watch it work on the right, and you can take the mouse away from it at any moment.

Above: one bot pulling Senate spending across four election cycles from `fec.gov`,
switching years through the site's own dropdown, then writing and running Python to build
a report — narrating as it goes.

## Why Linux is the right host for this

The expensive thing these products sell is "a computer of its own in the cloud." On macOS
they *have* to rent you a Linux VM to deliver it. On Linux that computer is just a
container with a virtual display, so several bots cost you tokens and nothing else.

It needs no root anywhere: rootless Docker, a `systemd --user` unit, and `loginctl
enable-linger` so your bots keep working after you log out.

## How it works

```
Tauri app  ──HTTP/WS──▶  daemon (systemd --user)  ──Docker API──▶  bot container
 React UI                Node 24 + SQLite                          Xvfb + Chrome + shim
 noVNC ──────────────────────────────────────────────────────────▶ the bot's screen
```

The agent loop lives in the **daemon**, never in the container: your OpenRouter key stays
out of the zone where untrusted web pages are read, models swap without rebuilding a 5GB
image, and transcripts stay on the host. The container is a replaceable "computer" behind
a typed action API — which is also what makes moving the daemon to an always-on box later
a base-URL change rather than a rewrite.

### The bot's computer is not headless

Xvfb + openbox + **real Google Chrome** at 1280x800, with a taskbar, a terminal and a file
manager. We launch Chrome ourselves and *attach* over CDP rather than letting Playwright
launch it, which keeps `navigator.webdriver === false`, avoids the automation infobar, and
leaves a desktop a human can take over.

### Browser control is by accessibility ref, not pixel coordinates

OpenRouter exposes plain OpenAI-style function calling, with no access to a
computer-use-tuned model. Asking a general model for the pixel position of a button is a
regression task it was never trained for; picking `s7e42` out of a labelled list is a
selection task every instruction-tuned model is good at. So the agent gets an
accessibility outline of the page and acts by ref. Refs are generation-scoped, so acting
on a stale one is a hard error rather than a wrong click.

### Watch it, then take the wheel

Watching is `view_only`; **Take over** flips that *and* claims a lease, so the agent stops
acting — without it, both drive the same X server and fight over the cursor. The lock is
one-directional: it stops the bot, never you. On release the agent resumes **on whatever
page you left it on**, in the same browser with the same session. That is how sign-ins
work: hit a login wall, the bot calls `ask_human`, you sign in by hand, it carries on.

## Setup

Needs Node 24+ (runs TypeScript natively), Rust, and rootless Docker. None of it needs root.

```bash
dockerd-rootless-setuptool.sh install    # -> unix:///run/user/1000/docker.sock
loginctl enable-linger "$USER"           # survive logout and reboot
pnpm install
container/build.sh 2>/dev/null || (cd container && docker build -t grokked/computer:0.1 .)

cp packages/daemon/deploy/grokked.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now grokked.service
```

Put your key in `~/.config/grokked/env` (mode 0600):

```
OPENROUTER_API_KEY=sk-or-...
DOCKER_HOST=unix:///run/user/1000/docker.sock
```

Then:

```bash
./run-app.sh          # starts docker + daemon + the bot's computer, opens the app
```

Prefer **rootless** Docker over adding yourself to the `docker` group: that group is
effectively root (`docker run -v /:/host`), a poor trade for a system whose job is holding
live credentials.

### Without the GUI

```bash
node packages/daemon/bin/task.ts "<goal>" fec.gov      # streams progress in the terminal

curl -X POST localhost:8787/v1/runs -H "Authorization: Bearer $(cat ~/.config/grokked/token)" \
  -d '{"bot_id":"bot-alpha","goal":"...","allowed_domains":["fec.gov"],"max_usd":5}'
```

And the container is drivable by hand with no model in the loop, which is how the browser
layer was built and verified:

```bash
container/act.sh navigate url=https://example.com
container/act.sh snapshot
container/act.sh run_bash command='python3 -c "print(1+1)"'
```

## The agent's tools

| | |
|---|---|
| Browser | `navigate` `snapshot` `click` `type` `find` `read_text` `scroll` `wait_for` `screenshot` |
| The machine | `run_bash` `write_file` `desktop_action` |
| Control | `finish` `give_up` `ask_human` |

The system prompt tells it that it *has a computer*, not that it can call a browser API:
use the shell when a shell is easier, read pages by ref rather than by screenshot, wait
for the thing you actually want, verify before reporting, and don't route around an
instruction — an answer obtained the way you were told not to is a failed task.

## Safety

- **Per-task domain allowlist, enforced in the container, not the prompt.** A hostile page
  can talk the model into anything; it cannot change what the shim checks.
- **Page text is fenced** in `<untrusted_page_content>` and the goal is immutable for the run.
- **Spending**: a per-run cap that pauses (one click to continue with more) plus step and
  wall-clock caps. The cap is a runaway-loop guardrail — the sidebar shows your actual
  remaining OpenRouter credit so the two are never confused.
- **CDP port 9222 is never published.** It is unauthenticated, and
  `Network.getAllCookies` over it would drain every session in the profile.
- The container never mounts your home directory. Only a narrow `work/` bind mount is shared.

## Status

Working today: the bot's computer, the agent loop, the desktop app, budgets, human takeover.

| | |
|---|---|
| **M0** | Daemon, schema, HTTP + WS with durable `?since=` replay, systemd unit |
| **M2** | The bot's computer: headful Chrome over CDP, shell, VNC takeover |
| **M3** | The harness: OpenRouter tool loop, durable runs, caps, loop detection |
| **M1** | Three-pane desktop app with the bot's live screen |
| next | **M4** approvals — the gate before pointing this at anything you're logged into |

Not done yet: approvals, persistent memory, learned routines, multiple bots working
together, prompt caching (which is the biggest cost lever still on the table).

## Layout

| Path | What |
|---|---|
| `packages/protocol` | Zod schemas shared by daemon and UI — change one, the other fails typecheck |
| `packages/daemon` | HTTP + WS, SQLite, agent loop, tool registry, Docker runtime |
| `packages/daemon/src/db/migrations` | Schema. Everything is downstream of `001_init.sql` |
| `container` | The bot's computer: Xvfb + openbox + Chrome + x11vnc + the CDP shim |
| `apps/desktop` | Tauri v2 + React client |

```
~/.config/grokked/env          OPENROUTER_API_KEY   (0600)
~/.config/grokked/config.json  model per role, default caps
~/.config/grokked/token        API bearer token     (0600, generated on first boot)
~/.local/share/grokked/        grokked.db, blobs, per-bot work dirs
```

## Design notes worth knowing before changing things

- **The daemon holds no run state that is not in SQLite.** One code path serves start,
  resume-after-crash, resume-after-approval and wake-from-sleep. Never add a second.
- **The WS is a cache-invalidation channel, not the source of truth.** Every frame is
  appended to `events` first so `?since=` replay can rebuild client state; a client whose
  `since` predates retention gets `hello{dropped:true}` and refetches.
- **`--password-store=basic` is load-bearing.** Without it Chrome looks for gnome-keyring
  over D-Bus, which a container has not got, and re-derives its cookie key each boot — so
  every login silently stops persisting and it looks like a broken volume.
- **BYOK keys report `usage.cost: 0`**; real spend is in
  `cost_details.upstream_inference_cost`. Reading `cost` alone disables every budget cap.

## Tests

```bash
node packages/daemon/test/ws-replay.test.ts
./node_modules/.bin/tsc --noEmit
```

## Name

`Grokked Bot` is a working title and leans on someone else's trademark. Worth renaming
before this goes anywhere public — this project is not affiliated with xAI, Grok, or
Anthropic.
