## What's new in 0.6.0

- **Just ask for a schedule.** Tell a bot "every weekday at 8, check Hacker News and give me
  the top story" (in the app or in Slack) and it sets up the schedule itself, then tells
  you when it next runs. One-off reminders ("Friday at 3pm") switch themselves off after
  they fire. Everything it sets up shows in its **Triggers** tab, where you can pause or
  change it. Bots now know how work reaches them, so they no longer promise to "check back
  later" when they can't.
- **Instructions for every bot.** A new **Settings → Instructions** box holds your standing
  rules (your time zone, tone, what to check with you first). Every bot follows them on
  every task, in the app, in Slack and on its schedules, without repeating them in each
  bot's Details.
- **See your version.** Settings now shows which version of Grokked Bot you're running
  (bottom left), so you can tell at a glance whether you're up to date.
- **A one-line diagnostics report.** When something goes wrong, one Terminal command
  writes a report to your Desktop (versions, Docker, your bots, Slack status, recent runs
  and the log) with every token and key scrubbed out, ready to send to whoever is helping.
- The bot's computer gets its 0.6.0 image. On first launch after upgrading, the app
  downloads it; your bots, logins and conversations carry over.

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
