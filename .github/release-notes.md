## Download for Mac

| Your Mac | Download |
|---|---|
| Apple Silicon (M1, M2, M3, M4) | **[Grokked-Bot-mac-apple-silicon.dmg](https://github.com/alnutile/grokked-bot/releases/latest/download/Grokked-Bot-mac-apple-silicon.dmg)** |
| Intel | [Grokked-Bot-mac-intel.dmg](https://github.com/alnutile/grokked-bot/releases/latest/download/Grokked-Bot-mac-intel.dmg) |

Not sure which you have? Apple menu → **About This Mac**. "Chip: Apple M…" means Apple Silicon.

You'll also need **[Docker Desktop](https://www.docker.com/products/docker-desktop/)** (or OrbStack) installed and running. It runs the private Linux computer each bot works on.

## Install

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
- Your settings, saved logins and history live in `~/Library/Application Support/Grokked/`. If something goes wrong, `daemon.log` in that folder has the details.
- Problems or ideas: [open an issue](https://github.com/alnutile/grokked-bot/issues).
