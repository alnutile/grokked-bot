---
name: evals
description: Run, read and extend Grokked Bot's eval suite — ten everyday web tasks (FEC, Wikipedia, Hacker News, Reddit, Indeed, saved logins, Google SSO, a job form with upload) graded automatically against the live stack. Use when asked to run the evals, check a build, compare models or their cost, see whether a change made the bot better or worse, or add a new eval task.
---

# Evals

The suite is the answer to "is the harness any good at web work, and is this build
better or worse?" It drives the real daemon, a real bot computer and live sites, and
grades with plain checks (substrings, file shapes, no leaked secrets).

- Tasks and checks: `packages/daemon/evals/tasks.ts`
- Local test pages (login, Google SSO popup, job form): `packages/daemon/evals/fixtures/`
- Runner: `packages/daemon/bin/eval.ts` · comparison: `packages/daemon/bin/eval-report.ts`
- Results: `~/.local/share/grokked/evals/<timestamp>--<model>.json`

## Running

```bash
pnpm eval                                   # the Settings worker model
pnpm eval --model x-ai/grok-4.6             # any tool-capable OpenRouter model
pnpm eval --only wiki-fact,apply-form       # a subset, while debugging one thing
pnpm eval:report                            # latest full run per model, side by side
```

A full run takes ~5 minutes. Run it in the background and read the summary when it
lands. It uses its own **Eval** bot (`eval-bot`), so the user's bots, logins and
conversations are never touched, and it deletes the test logins it creates.

Before running:

1. **Check nothing of the user's is mid-run** (`GET /v1/runs`, states `running`/`queued`
   on bots other than `eval-bot`). Restarting the daemon or rebuilding the image while
   a run is live recreates that bot's computer under it. Never chain a "check" and a
   restart in one command — read the check first.
2. **If the shim or image changed, rebuild first**
   (`docker build -t grokked/computer:0.1 container`) and restart the daemon; the eval
   bot's computer is recreated on the newer image automatically.
3. **Mind the cost.** A full run is ~$1 on gpt-5.6-sol or grok-4.6. Expensive models
   (anything Fable- or Opus-class) cost several times that — say the estimate and get a
   yes before running one. Check live prices with
   `curl -s https://openrouter.ai/api/v1/models`.

## Reading results

Each task prints PASS/FAIL, steps, cost, seconds and tool errors, and ▼ REGRESSED / ▲ fixed
against the last run on the same model. A failure lists why. Before calling anything a
bot regression, open the run (`run_id` in the results JSON →
`GET /v1/runs/<id>/steps`, `GET /v1/threads/<thread_id>`) and decide which it is:

- **Harness bug** (our code): tool errors, stale refs, truncated pages, a tool the bot
  needed and didn't have. Fix it; this is the point of the suite.
- **Fixture or check bug**: the bot did the right thing and the page or the check was
  wrong (e.g. a test page printing "undefined"). Fix the fixture/check and say so.
- **Live site drift**: the site changed or the data moved on (a new top spender, a
  closed posting). Update the check, note it in the commit.
- **Model weakness**: the bot reasoned badly with good tools. Worth comparing models.

Steps and cost per pass matter as much as pass/fail: a task that passes in 60 steps
is a harness problem waiting to happen.

## Adding a task

Add an `EvalTask` to `TASKS` in `evals/tasks.ts`. Keep it an everyday job, cheap, and
checkable without a human; prefer `all`/`any` substrings that a correct answer can't
avoid, and `file` checks for anything that produces a document. If it needs a page we
control, add it to `evals/fixtures/` (served at `http://localhost:8000` inside the bot's
computer). If it needs a login, create it in `setup()` in `bin/eval.ts`, scoped to
`eval-bot`, and add its secret to `SECRETS` with a `noLeak` check.

**Never add tasks that sign in to the user's real accounts, and never LinkedIn** — the
user can't risk being locked out.

## After a run

Report the summary table (pass rate, total $, $ per pass, notable step counts), any
regressions with their cause, and what you'd change. Commit eval/harness fixes with the
before/after numbers in the message.
