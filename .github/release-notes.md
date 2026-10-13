## What's new in 0.4.1

- **Saving a bot's Env works.** In the 0.4.0 app, clicking Save on the Env tab said
  "Couldn't save: Load failed". It saves now.

### New in 0.4.0

- **Copy and pin a bot's answer.** Every response has a **Copy** button, so you can paste
  an answer anywhere without selecting text, and a **Pin** button that saves it to
  **Pinned results** in the sidebar: everything you pinned, newest first, each with a
  link back to the conversation it came from.
- **Bots that can code.** Hand a bot a repo and it clones it, installs the language the
  project needs, reads and edits the code, runs the tests and commits. With a GitHub token
  it pushes a branch, opens a pull request, waits on CI and fixes what fails. Languages it
  installs stay installed, even after an update.
- **Each bot gets its own limits.** Set max steps and minutes per message in a bot's
  Details, so a coding bot can work for hours while a shopping bot stays on a short leash.
  The defaults are higher too: 150 steps and 3 hours.
- **Limits that follow the model.** How much a bot reads and writes in one step now comes
  from what OpenRouter says the model can handle, so a 1M-token model sees whole files and
  test logs. Switch models and it adjusts on its own.
- **A clearer README.** It opens with a Get started section: what you need, which
  download fits your machine, and your first task in about a minute.
- **Every change is checked before it lands.** Tests, type checks and a full build of
  the bot's computer run on every pull request, and merging a version bump ships the
  release (Mac, Linux and the bot computer image) on its own.
- The bot's computer gets an update too. On first launch after upgrading, the app downloads
  the new image; your bots, logins and conversations carry over.

**Also new since 0.2.1** (0.3.0 shipped as a draft only):

- **Environment variables per bot.** A new **Env** tab: paste a `.env` file and every
  command the bot runs gets those variables, stored encrypted and never shown to the bot.
- **Bots can work on GitHub.** Put a `GITHUB_TOKEN` in a bot's Env tab and it can clone
  your private repos and use `gh`. The bot's computer now includes `git`, `gh` and `jq`.

## Download for Mac

| Your Mac | Download |
|---|---|
| Apple Silicon (M1, M2, M3, M4) | **[Grokked-Bot-mac-apple-silicon.dmg](https://github.com/alnutile/grokked-bot/releases/latest/download/Grokked-Bot-mac-apple-silicon.dmg)** |
| Intel | [Grokked-Bot-mac-intel.dmg](https://github.com/alnutile/grokked-bot/releases/latest/download/Grokked-Bot-mac-intel.dmg) |

Not sure which you have? Apple menu → **About This Mac**. "Chip: Apple M…" means Apple Silicon.

You'll also need **[Docker Desktop](https://www.docker.com/products/docker-desktop/)** (or OrbStack) installed and running. It runs the private Linux computer each bot works on.

## Download for Linux

| Package | Download |
|---|---|
| Ubuntu / Debian (24.04+) | **[Grokked-Bot-linux-amd64.deb](https://github.com/alnutile/grokked-bot/releases/latest/download/Grokked-Bot-linux-amd64.deb)** |
| Any distro | [Grokked-Bot-linux-x86_64.AppImage](https://github.com/alnutile/grokked-bot/releases/latest/download/Grokked-Bot-linux-x86_64.AppImage) |

```bash
sudo apt install ./Grokked-Bot-linux-amd64.deb     # then open Grokked Bot from your apps
# or
chmod +x Grokked-Bot-linux-x86_64.AppImage && ./Grokked-Bot-linux-x86_64.AppImage
```

You'll need [Docker](https://docs.docker.com/engine/install/) running (rootless Docker works too). No security prompt on Linux. If the AppImage won't start, install `libfuse2` or run it with `--appimage-extract-and-run`.

## Install on a Mac

1. Open the `.dmg` and drag **Grokked Bot** into **Applications**.
2. Open Grokked Bot. **macOS will block it the first time.** This build isn't notarized by Apple yet, so you'll see *"Apple could not verify 'Grokked Bot' is free of malware"*. Click **Done**.
3. Open **System Settings → Privacy & Security**, scroll down to *"Grokked Bot was blocked to protect your Mac"*, and click **Open Anyway**. Enter your password, then click **Open Anyway** once more.

You only do step 3 once per version.

## First run

The app walks you through three things:

1. **Docker**: it checks Docker Desktop is running.
2. **The bot's computer**: a one-time download of about 5 GB. Give it 10 minutes or so.
3. **An OpenRouter key**: how your bots think. [Create one here](https://openrouter.ai/settings/keys); usage is billed to your OpenRouter account.

Then create a bot with **+** and give it a job.

## Good to know

- **Bots stop when you quit the app.** Leave it open (or minimized) while they work.
- On Apple Silicon the bot's Chrome runs under Rosetta, so it's a little slower than on Linux.
- Your settings, saved logins and history live in `~/Library/Application Support/Grokked/` on a Mac, and `~/.config/grokked-app/` plus `~/.local/share/grokked-app/` on Linux. If something goes wrong, `daemon.log` in the config folder has the details.
- Problems or ideas: [open an issue](https://github.com/alnutile/grokked-bot/issues).
