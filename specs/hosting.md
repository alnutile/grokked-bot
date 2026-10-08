# Hosting Grokked Bot in the cloud

Status: discussion draft (2026-10-08). Prices are approximate, from memory of AWS's
on-demand list prices in us-east-1 — check the AWS pricing calculator before deciding.

## What a bot actually uses

Measured on the dev machine (`docker stats`, per-process RSS):

| | Memory | CPU |
|---|---|---|
| One bot computer, idle | 400–900 MB | ~0.3–3% |
| One bot computer, browsing a heavy site | up to ~1.5 GB | bursts to 1+ core |
| Desktop layer (Xvfb + openbox + tint2) | ~115 MB | — |
| Screen streaming (x11vnc + websockify) | ~85 MB | — |
| Daemon | ~100–200 MB | low |
| Image on disk (shared by all bots) | 4.8 GB | — |

Rule of thumb: **~1.5 GB RAM and a share of one CPU per bot**. Bots are idle most of the
day, which suits burstable instances (AWS t3).

## Estimates

| Setup | Instance | Approx. per month | Per person |
|---|---|---|---|
| One machine per person, 2–3 bots | t3.large (2 vCPU, 8 GB) | ~$61 + ~$4 EBS | ~$65 (~$45 with a 1-yr savings plan) |
| Shared, ~4 people × 2 bots | t3.xlarge (4 vCPU, 16 GB) | ~$121 + ~$6 EBS | ~$32 |
| Shared, ~8 people | t3.2xlarge (8 vCPU, 32 GB) | ~$243 | ~$30 |
| Cheaper than AWS | Lightsail 16 GB / Hetzner 16 GB | ~$80 / ~$30 | $10–20 |

Notes:

- **x86 only.** Google Chrome has no Linux ARM build, and the bot computers use real
  Chrome on purpose (SSO risk engines distrust Chromium). Graviton (t4g) savings don't apply.
- **Data transfer is close to free**: bots mostly download pages, and inbound is free.
- **Spot instances** (~60–70% off) can be reclaimed mid-run. Disks survive, but the
  in-flight run dies. Fine for batch-style schedules, poor for interactive use.
- **Disk**: 30–50 GB gp3 per machine (~$0.08/GB-month).

## Model costs (usually the bigger number)

From the eval suite on gpt-5.6-sol: ~$0.016 per step, ~$0.09 per everyday task. A person
running ~20 tasks/day ≈ $40–60/month. Long agentic jobs (60-step LinkedIn runs) cost
$1–2 each. Each person can bring their own OpenRouter key, keeping spend separate.
Claude models are ~6× cheaper per step than before now that prompt caching is on, but
still pricier than gpt-5.6-sol / grok-4.6 for the same pass rate on our evals.

## One machine per person, or shared?

- **Per person** — strong isolation (own vault, logins, webhook tokens, Docker host).
  Grokked is single-user today (one daemon = one person), so this fits as-is.
- **Shared** — about half the cost. Run one daemon *instance* per person on one host
  using per-instance config/data dirs, ports and container prefixes
  (`GROKKED_CONFIG_DIR`, `GROKKED_DATA_DIR`, `GROKKED_PORT`, `GROKKED_HOOKS_PORT`,
  `GROKKED_CONTAINER_PREFIX` — the same mechanism as the local test instance). Weaker
  isolation: everyone shares one Docker host. Suits a team, not strangers.

## What's missing before this works remotely

The desktop app assumes its daemon is on the same computer. Needed:

1. **Daemon listening on the tailnet**, not just loopback (`GROKKED_HOST` exists; needs
   a deliberate bind to the Tailscale address plus the bearer token on every call).
2. **"Connect to a remote daemon"** in the app: a server URL + token, instead of always
   spawning its own.
3. **Bot screens over the network**: each bot's noVNC is on a loopback-only, per-bot
   port today. Either the daemon proxies them (one port, routed by bot) or Tailscale
   exposes them.
4. **Webhooks** already have their own listener and Tailscale serve/Funnel switches, so
   they work unchanged on a server.

Estimated effort: a few days, not a redesign.

## Suggested first step

One t3.large running your own bots, reached over Tailscale, to learn the real usage
pattern before sizing anything shared.

## Open questions

- Who are the users — a team that trusts each other, or separate customers?
- Interactive (watching, taking over) or mostly webhooks/schedules?
- Bring-your-own OpenRouter key, or one shared key with per-person budgets?
