## What's new in 0.5.0

- **Your bots in Slack.** A new **Slack** tab turns a bot into a Slack teammate with its own
  name and face. A step-by-step guide hands you the app manifest and the bot's icon, you
  paste two tokens, and that's it: no public URL or tunnel, it connects out from your
  computer. DM it or @mention it in a channel and it reacts 👀, shows what it's working on,
  and answers in the thread. Only people you allow can use it.
- **Bots can log in to your servers over SSH.** A new **SSH** tab gives each bot its own
  key. Copy the public key (or the one-line install command) onto a server, list the
  servers it may use, and click **Test**. Then just ask: "how much disk is free on the web
  server?" The private key is stored encrypted and the bot can use it but never see it.
- The bot's computer gets an update (SSH tools). On first launch after upgrading, the app
  downloads the new image; your bots, logins and conversations carry over.

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
