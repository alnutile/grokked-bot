# Grokked Bot

**An open-source AI teammate that runs on your own Linux box.** Powered by
[OpenRouter](https://openrouter.ai), so you pick the model. Inspired by Grok Bot and
Claude Cowork — the difference is that the "computer" your agent works on is a container
on hardware you already own, not a cloud VM you rent.

![The app: bot list, the conversation, and the bot's live screen](docs/img/grokked-bot.png)

You message a bot like a colleague. It has **its own computer** — a real desktop with a
real browser it stays logged into, plus a shell — and it uses whichever fits the job. You
watch it work on the right, and you can take the mouse away from it at any moment.

Above: asked for the top 10 spenders of 2024 on `fec.gov`, the bot opened the page, read
the table and answered in three steps for about five cents — and said which view it had
read, so you know what to ask for next. On the right is its live screen, with a human
holding control.

## Quick start

Tested on Ubuntu with Node 24. Nothing below needs root except installing system packages.

### 1. Install the prerequisites

| | |
|---|---|
| **Node 24+** | Runs the TypeScript daemon directly, no build step. [nvm](https://github.com/nvm-sh/nvm) works fine. |
| **pnpm** | `corepack enable` (ships with Node) |
| **Rust** | [rustup.rs](https://rustup.rs) — for the Tauri desktop app |
| **Tauri's system libs** | `sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev` |
| **Rootless Docker** | [docs.docker.com/engine/security/rootless](https://docs.docker.com/engine/security/rootless/) |
| **An OpenRouter key** | [openrouter.ai/keys](https://openrouter.ai/keys), with a few dollars of credit |

Then set up rootless Docker and let your user services outlive your login:

```bash
dockerd-rootless-setuptool.sh install
systemctl --user enable --now docker.service
loginctl enable-linger "$USER"          # bots keep working after you log out
```

Prefer **rootless** Docker over adding yourself to the `docker` group: that group is
effectively root (`docker run -v /:/host`), a poor trade for a system whose job is holding
live credentials.

### 2. Get the code and build the bot's computer

```bash
git clone https://github.com/alnutile/grokked-bot.git
cd grokked-bot
pnpm install

export DOCKER_HOST=unix:///run/user/$(id -u)/docker.sock
docker build -t grokked/computer:0.1 container/     # ~5GB, takes a few minutes
```

### 3. Add your OpenRouter key

```bash
mkdir -p ~/.config/grokked
printf 'OPENROUTER_API_KEY=sk-or-...\n' > ~/.config/grokked/env
chmod 600 ~/.config/grokked/env
```

### 4. Install the daemon

The daemon is a `systemd --user` service. The unit file has placeholders for where Node
and this repo live; this fills them in:

```bash
mkdir -p ~/.config/systemd/user
sed -e "s|@NODE@|$(command -v node)|" -e "s|@REPO@|$PWD|g" \
  packages/daemon/deploy/grokked.service > ~/.config/systemd/user/grokked.service
systemctl --user daemon-reload
systemctl --user enable --now grokked.service

systemctl --user status grokked           # should say active (running)
```

If you upgrade Node later (nvm puts the version in the path), re-run the `sed` line.

### 5. Open the app

```bash
./run-app.sh
```

The first run compiles the Tauri app, which takes a few minutes. After that it opens in
seconds.

## Your first task

1. Click **+ New bot** and give it a name. Each bot gets its own computer — its own
   container, browser profile and logins — created the first time it's needed.
2. In the box above the message field, list the domains the bot may visit, for example
   `fec.gov`. This allowlist is enforced inside the container, not just in the prompt.
   **max $** caps what this one run may spend.
3. Type what you want, the way you would to a colleague, and press **Ctrl+Enter**.

The conversation shows each step as it happens, and the bot's screen on the right shows
what it's doing. If it hits something it can't do alone — a login wall, a CAPTCHA — it
asks you.

**Taking over.** Click **Take over** to pause the bot and drive its screen yourself, full
size; this is how you sign in to sites for it. **Paste from my PC** pastes your clipboard
where the bot's cursor is (handy for passwords), and **Copy to my PC** brings back
whatever you copied on its screen. The ⤢ button opens the screen full size just to watch. Click **Give control back** and it picks up on
whatever page you left it, in the same browser with the same session. Logins are kept in
the bot's profile, so you sign in once.

The sidebar shows your remaining OpenRouter credit. The app connects to the bot's screen
for you. To watch a bot in a full browser tab instead, `./vnc.sh` lists every running bot
with its password and a link that logs straight in; `./vnc.sh <bot-id>` opens that one.

## Troubleshooting

| Symptom | Fix |
|---|---|
| App says the daemon is offline | `systemctl --user status grokked`, then `journalctl --user -u grokked -n 50` |
| `Cannot connect to the Docker daemon` | `export DOCKER_HOST=unix:///run/user/$(id -u)/docker.sock` and `systemctl --user start docker` |
| Bot's screen stays blank or says "computer unreachable" | Click **Restart computer**. The first start can take a minute while Chrome comes up. |
| A run ends **blocked** | Something stopped it — usually a domain not on the allowlist, or a page it couldn't get past. The run's last steps say which. Take over if it needs you, then send another message. |
| A run pauses on budget | It hit its **max $**. Continue it with more, or raise the default in `~/.config/grokked/config.json`. |
| Model errors on boot | A model id in `~/.config/grokked/config.json` no longer exists on OpenRouter. The daemon log names it. |

Each bot's computer is a container named after the bot (`docker ps`). Docker picks free
host ports for its screen and its control API, so any number of bots can run side by side.

## Configuration

```
~/.config/grokked/env          OPENROUTER_API_KEY, optional DOCKER_HOST   (0600)
~/.config/grokked/config.json  model per role, default caps (written on first boot)
~/.config/grokked/token        API bearer token     (0600, generated on first boot)
~/.local/share/grokked/        grokked.db, blobs, per-bot work dirs
```

`config.json` picks a model for each role — `worker` does the actual task — using any
OpenRouter model id, and sets the default per-run caps (`max_steps`, `max_usd`,
`max_wall_s`). The daemon listens on `127.0.0.1:8787`; set `GROKKED_PORT` in the env file
to change it.

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
one-directional: it stops the bot, never you. On release the agent resumes on whatever
page you left it on. That is how sign-ins work: hit a login wall, the bot calls
`ask_human`, you sign in by hand, it carries on.

## Without the GUI

```bash
TOKEN=$(cat ~/.config/grokked/token)

# Hand the default bot a job and stream its progress in the terminal
node packages/daemon/bin/task.ts "<goal>" fec.gov

# Or over the API: create a bot, then give it a run
curl -X POST localhost:8787/v1/bots -H "Authorization: Bearer $TOKEN" \
  -d '{"id":"bot-alpha","name":"Alpha"}'
curl -X POST localhost:8787/v1/runs -H "Authorization: Bearer $TOKEN" \
  -d '{"bot_id":"bot-alpha","goal":"...","allowed_domains":["fec.gov"],"max_usd":5}'
```

And the container is drivable by hand with no model in the loop, which is how the browser
layer was built and verified. `container/run.sh <name>` starts a standalone computer and
prints its ports; `act.sh` talks to it:

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
- **Everything binds to `127.0.0.1`.** The screen and control ports are loopback-only, and
  VNC is password-protected on top of that.
- The container never mounts your home directory. Only a narrow `work/` bind mount is shared.

Approvals — a gate before the bot acts on a site you're logged into — are not built yet.
Until they are, keep the domain allowlist tight on any bot that holds real logins.

## Status

Working today: the bot's computer, the agent loop, the desktop app, multiple bots side by
side, budgets, human takeover.

| | |
|---|---|
| **M0** | Daemon, schema, HTTP + WS with durable `?since=` replay, systemd unit |
| **M2** | The bot's computer: headful Chrome over CDP, shell, VNC takeover |
| **M3** | The harness: OpenRouter tool loop, durable runs, caps, loop detection |
| **M1** | Three-pane desktop app with the bot's live screen |
| next | **M4** approvals — the gate before pointing this at anything you're logged into |

Not done yet: approvals, persistent memory, learned routines, bots working together,
prompt caching (which is the biggest cost lever still on the table).

## Layout

| Path | What |
|---|---|
| `packages/protocol` | Zod schemas shared by daemon and UI — change one, the other fails typecheck |
| `packages/daemon` | HTTP + WS, SQLite, agent loop, tool registry, Docker runtime |
| `packages/daemon/src/db/migrations` | Schema. Everything is downstream of `001_init.sql` |
| `container` | The bot's computer: Xvfb + openbox + Chrome + x11vnc + the CDP shim |
| `apps/desktop` | Tauri v2 + React client |

## Design notes worth knowing before changing things

- **The daemon holds no run state that is not in SQLite.** One code path serves start,
  resume-after-crash, resume-after-approval and wake-from-sleep. Never add a second.
- **The WS is a cache-invalidation channel, not the source of truth.** Every frame is
  appended to `events` first so `?since=` replay can rebuild client state; a client whose
  `since` predates retention gets `hello{dropped:true}` and refetches.
- **Never assume a bot's ports.** Docker assigns them per container and can change them on
  restart; ask the runtime (`LocalDockerRuntime.ports()`). Pinning them is what once let
  one bot's screen open with another bot's VNC password.
- **`--password-store=basic` is load-bearing.** Without it Chrome looks for gnome-keyring
  over D-Bus, which a container has not got, and re-derives its cookie key each boot — so
  every login silently stops persisting and it looks like a broken volume.
- **BYOK keys report `usage.cost: 0`**; real spend is in
  `cost_details.upstream_inference_cost`. Reading `cost` alone disables every budget cap.

## Tests

```bash
pnpm test
pnpm typecheck
```

## Name

`Grokked Bot` is a working title and leans on someone else's trademark. Worth renaming
before this goes anywhere public — this project is not affiliated with xAI, Grok, or
Anthropic.
