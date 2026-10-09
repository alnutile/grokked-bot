# Changelog

What changed in Grokked Bot, newest first, written for the people who use it. Each entry
says what you can now do and why it matters. Downloads for every release are on the
[Releases page](https://github.com/alnutile/grokked-bot/releases).

## Unreleased

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

## 0.3.0 (2026-10-09)

- **Environment variables per bot.** A new **Env** tab: paste a `.env` file and every
  command the bot runs in its shell gets those variables. They're stored encrypted. The
  bot is told their names but never their values, and anything that looks like a secret
  is masked in what it sees.
- **Bots can work on GitHub.** Add a `GITHUB_TOKEN` and the bot can `git clone` your
  private repos and use the `gh` command (issues, pull requests, CI), with the token never
  appearing in the conversation.
- The bot's computer now includes `git`, `gh` and `jq`.

## 0.2.1 (2026-10-08)

- **Sites with a browser sign-in popup** (HTTP basic auth, like many API docs pages) now
  work: save the login once and the bot signs in without ever seeing the password.
- **Media tab:** text and JSON files preview again, and new buttons open a file, show it
  in its folder, or open the bot's whole folder.
- **The bot's computer updates with the app.** After an upgrade the app downloads the
  matching bot computer, and your bots keep their logins.

## 0.2.0 (2026-10-07)

- **Linux app.** A `.deb` for Ubuntu and Debian 24.04+, and an AppImage for any distro.
  Like the Mac app, it walks you through Docker, the bot's computer and your key, and it
  can run next to a from-source install.
- Webhooks that are only reachable on your tailnet now say how to reach them, instead of
  just refusing.

## 0.1.0 (2026-10-07)

The first release: an AI teammate with its own computer, on your own machine.

- **Bots with their own computer.** Each bot gets a real Linux desktop with Chrome, a
  terminal and a file manager, running in Docker on your machine, with its own logins
  and files. Run as many side by side as you like.
- **Watch and take over.** See the bot's screen live, take the mouse at any moment, and
  hand it back; it carries on from where you left it. Paste from your PC into its screen
  and copy back.
- **Real conversations.** Follow-ups, automatic titles, history that survives restarts,
  and a bot that stops to ask when it hits a login wall, a CAPTCHA or a question.
- **Saved logins, encrypted,** typed by the app only on the right site and never shown
  to the model. **Sign in with Google, Microsoft, Apple or GitHub** too.
- **Webhooks and schedules** per bot, reachable from your phone or other apps through
  Tailscale or any tunnel.
- **Budgets and limits** per message, a site allowlist enforced inside the bot's
  computer, and your OpenRouter credit in the sidebar.
- **Any model on OpenRouter,** chosen in Settings or per bot.
- **Mac app** for Apple Silicon and Intel, with a first-run setup screen.
- **Evals:** ten real web tasks to compare models and catch regressions.
