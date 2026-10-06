import { Hono } from 'hono'
import type { Db } from '../db/index.ts'
import type { EventBus } from '../events.ts'
import { addHumanReply, createRun, createThread, executeStep } from '../agent/loop.ts'
import { buildTranscript } from '../agent/transcript.ts'
import { autoTitle } from '../agent/titles.ts'
import { getBot } from './bots.ts'
import { LocalDockerRuntime, type BotRuntime } from '../runtime/container.ts'
import { log } from '../log.ts'
import { credits } from '../model/openrouter.ts'

const runtimes = new Map<string, BotRuntime>()
const runtimeFor = (botId: string): BotRuntime => {
  let r = runtimes.get(botId)
  if (!r) { r = new LocalDockerRuntime(botId); runtimes.set(botId, r) }
  return r
}

/** Runs advance in the background; the request returns as soon as the run exists.
 *  All progress reaches clients over the WS, and all state is in SQLite, so a
 *  crash mid-run resumes rather than losing work. */
const active = new Set<string>()
function drive(db: Db, bus: EventBus, botId: string, runId: string): void {
  if (active.has(runId)) return
  active.add(runId)
  ;(async () => {
    try {
      for (;;) {
        const out = await executeStep(db, bus, runtimeFor(botId), runId)
        if (out.done) { log.info({ runId, state: out.state }, 'run finished'); break }
      }
    } catch (e) {
      log.error({ runId, err: (e as Error).message }, 'run crashed')
      db.prepare("UPDATE runs SET state='failed', state_reason=? WHERE id=?")
        .run(`crashed: ${(e as Error).message}`.slice(0, 300), runId)
    } finally {
      active.delete(runId)
    }
  })()
}

export function mountRuns(app: Hono, db: Db, bus: EventBus): void {
  const currentThread = (botId: string) =>
    (db.prepare(
      `SELECT id FROM threads WHERE bot_id = ? AND kind = 'chat' ORDER BY created_at DESC LIMIT 1`,
    ).get(botId) as { id: string } | undefined)?.id

  const latestRun = (threadId: string) =>
    db.prepare('SELECT * FROM runs WHERE thread_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(threadId) as (RunState & Record<string, unknown>) | undefined

  /** Resume a run that was waiting on the human. The wait doesn't count against
   *  its time limit: the clock restarts now, or replying after an hour away
   *  would fail the run on the spot. */
  const requeue = (runId: string, botId: string) => {
    db.prepare("UPDATE runs SET state='queued', state_reason=NULL, started_at=? WHERE id=?").run(Date.now(), runId)
    bus.emit({ topic: `run:${runId}`, type: 'run.state', run_id: runId, data: { run_id: runId, state: 'queued' } })
    drive(db, bus, botId, runId)
  }

  const transcript = (threadId: string) => buildTranscript(db, threadId)

  /** A message to a bot, in a conversation: `thread_id` names one, `new_thread`
   *  starts one, and neither continues the bot's latest. If the bot is waiting on
   *  the human, this is the answer and that run carries on; otherwise it starts a
   *  new run in the thread, which sees the earlier exchanges. Domains and budget
   *  fall back to the bot's defaults. */
  app.post('/v1/runs', async (c) => {
    const body = await c.req.json<{
      bot_id: string; goal: string; allowed_domains?: string[]
      max_steps?: number; max_usd?: number; thread_id?: string; new_thread?: boolean
    }>()
    const bot = getBot(db, body.bot_id)
    if (!bot) return c.json({ error: 'no_such_bot', message: `no bot ${body.bot_id}` }, 404)
    if (body.thread_id) {
      const t = db.prepare('SELECT bot_id FROM threads WHERE id = ?').get(body.thread_id) as { bot_id: string } | undefined
      if (t?.bot_id !== body.bot_id) return c.json({ error: 'no_such_thread' }, 404)
    }
    const threadId = body.thread_id
      ?? (body.new_thread ? undefined : currentThread(body.bot_id))
      ?? createThread(db, body.bot_id)
    body.allowed_domains ??= bot.default_domains
    body.max_usd ??= bot.default_max_usd ?? undefined
    const last = latestRun(threadId)
    if (last && ['queued', 'running'].includes(last.state)) {
      return c.json({ error: 'busy', message: 'this bot is still working on your last message — stop it first' }, 409)
    }
    if (last && waitingOnHuman(last)) {
      addHumanReply(db, last.id, body.goal)
      if (body.allowed_domains) {
        db.prepare('UPDATE runs SET allowed_domains_json = ? WHERE id = ?')
          .run(JSON.stringify(body.allowed_domains), last.id)
      }
      requeue(last.id, body.bot_id)
      return c.json({ run: db.prepare('SELECT * FROM runs WHERE id=?').get(last.id), resumed: true }, 200)
    }
    const runId = createRun(db, { ...body, thread_id: threadId })
    if (!last) autoTitle(db, bus, threadId, body.bot_id, body.goal)
    bus.emit({ topic: `bot:${body.bot_id}`, type: 'run.created', run_id: runId,
               bot_id: body.bot_id, data: { run_id: runId, goal: body.goal } })
    drive(db, bus, body.bot_id, runId)
    return c.json({ run: db.prepare('SELECT * FROM runs WHERE id=?').get(runId) }, 201)
  })

  /** The bot's current conversation as chat entries, so the app can show it
   *  after a restart or a bot switch. */
  app.get('/v1/bots/:id/thread', (c) => {
    const threadId = currentThread(c.req.param('id'))
    if (!threadId) return c.json({ thread_id: null, entries: [], run: null })
    return c.json({ thread_id: threadId, entries: transcript(threadId), run: latestRun(threadId) ?? null })
  })

  /** Every conversation, newest first, for the sidebar. The preview is how the
   *  latest exchange ended, or what was asked if it hasn't yet. */
  app.get('/v1/threads', (c) => c.json({
    threads: db.prepare(
      `SELECT t.id, t.bot_id, t.title, t.last_message_at,
              (SELECT COALESCE(r.outcome_summary, r.goal) FROM runs r
                WHERE r.thread_id = t.id ORDER BY r.created_at DESC LIMIT 1) AS preview,
              (SELECT r.state FROM runs r WHERE r.thread_id = t.id ORDER BY r.created_at DESC LIMIT 1) AS state
       FROM threads t
       WHERE t.kind = 'chat' AND EXISTS (SELECT 1 FROM runs r WHERE r.thread_id = t.id)
       ORDER BY t.last_message_at DESC LIMIT 200`,
    ).all(),
  }))

  app.get('/v1/threads/:id', (c) => {
    const id = c.req.param('id')
    const thread = db.prepare('SELECT id, bot_id, title, title_source FROM threads WHERE id = ?').get(id)
    if (!thread) return c.json({ error: 'not_found' }, 404)
    return c.json({ thread, entries: transcript(id), run: latestRun(id) ?? null })
  })

  /** Renaming makes the title the human's; the automatic one never overwrites it. */
  app.patch('/v1/threads/:id', async (c) => {
    const { title } = await c.req.json<{ title?: string }>()
    if (typeof title !== 'string') return c.json({ error: 'bad_request' }, 400)
    db.prepare(`UPDATE threads SET title = ?, title_source = 'human' WHERE id = ?`)
      .run(title.trim().slice(0, 120), c.req.param('id'))
    return c.json({ ok: true })
  })

  /** Start a fresh conversation; the next message won't see the old one. */
  app.post('/v1/bots/:id/threads', (c) => {
    const botId = c.req.param('id')
    const busy = db.prepare(
      `SELECT 1 FROM runs WHERE bot_id = ? AND state IN ('queued','running')`,
    ).get(botId)
    if (busy) return c.json({ error: 'busy', message: 'stop the current run first' }, 409)
    return c.json({ thread_id: createThread(db, botId) }, 201)
  })

  app.get('/v1/runs', (c) =>
    c.json({ runs: db.prepare('SELECT * FROM runs ORDER BY created_at DESC LIMIT 50').all() }))

  app.get('/v1/runs/:id', (c) => {
    const run = db.prepare('SELECT * FROM runs WHERE id=?').get(c.req.param('id'))
    return run ? c.json({ run }) : c.json({ error: 'not_found' }, 404)
  })

  app.get('/v1/runs/:id/steps', (c) =>
    c.json({
      steps: db.prepare('SELECT * FROM run_steps WHERE run_id=? ORDER BY step_no').all(c.req.param('id')),
      llm_calls: db.prepare(
        'SELECT step_no, model, prompt_tokens, completion_tokens, cached_tokens, cost_usd, latency_ms FROM llm_calls WHERE run_id=? ORDER BY step_no',
      ).all(c.req.param('id')),
    }))

  app.post('/v1/runs/:id/cancel', (c) => {
    db.prepare("UPDATE runs SET cancel_requested=1, state='cancelled' WHERE id=?").run(c.req.param('id'))
    return c.json({ ok: true })
  })

  /** What you can actually spend. The per-run cap is a loop guardrail; this is
   *  the budget, and the UI shows it so the cap is never mistaken for it. */
  app.get('/v1/credits', async (c) => c.json((await credits()) ?? { error: 'unavailable' }))

  /** Resume anything left mid-flight by a restart, or continue a run that hit
   *  its per-run cap. `add_usd` raises the ceiling for this run only -- the loop
   *  cannot tell the difference between this and a normal step, which is the point. */
  app.post('/v1/runs/:id/resume', async (c) => {
    const id = c.req.param('id')
    const run = db.prepare('SELECT bot_id, state, max_usd, spend_usd FROM runs WHERE id=?').get(id) as
      { bot_id: string; state: string; max_usd: number; spend_usd: number } | undefined
    if (!run) return c.json({ error: 'not_found' }, 404)

    const body: { add_usd?: number } = await c.req.json<{ add_usd?: number }>().catch(() => ({}))
    const add = Number(body.add_usd ?? 0)
    if (add > 0) {
      db.prepare('UPDATE runs SET max_usd = max_usd + ? WHERE id=?').run(add, id)
    } else if (run.spend_usd >= run.max_usd) {
      return c.json({
        error: 'still_over_cap',
        message: `run has spent $${run.spend_usd.toFixed(4)} of $${run.max_usd.toFixed(2)}; pass add_usd to continue`,
      }, 409)
    }
    db.prepare("UPDATE runs SET state='queued', state_reason=NULL WHERE id=?").run(id)
    drive(db, bus, run.bot_id, id)
    return c.json({ ok: true, resumed: id, max_usd: run.max_usd + add })
  })

  app.get('/v1/bots/:id/computer', async (c) => {
    const rt = runtimeFor(c.req.param('id')) as LocalDockerRuntime
    const ports = await rt.ports().catch(() => null)
    return c.json({
      vnc_url: ports ? await rt.vncUrl() : null,
      vnc_port: ports?.vnc ?? null,
      vnc_password: await rt.vncPassword().catch(() => null),
      human_in_control: await rt.isHumanInControl().catch(() => false),
    })
  })

  // Proxied so the UI never talks to a container directly -- the same call will
  // work unchanged once the daemon lives on a remote box.
  app.post('/v1/bots/:id/takeover', async (c) => {
    const rt = runtimeFor(c.req.param('id')) as LocalDockerRuntime
    const body: { holder?: string; ttl_s?: number } =
      await c.req.json<{ holder?: string; ttl_s?: number }>().catch(() => ({}))
    const r = await fetch(await rt.shimUrl('/takeover'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ holder: body.holder ?? 'you', ttl_s: body.ttl_s ?? 900 }),
    })
    return c.json(await r.json())
  })

  // Giving control back wakes whatever was waiting on the human: a run that
  // paused because you took over, or one that asked for help (usually a login).
  app.delete('/v1/bots/:id/takeover', async (c) => {
    const botId = c.req.param('id')
    const rt = runtimeFor(botId) as LocalDockerRuntime
    const r = await fetch(await rt.shimUrl('/takeover'), { method: 'DELETE' })
    const threadId = currentThread(botId)
    const last = threadId ? latestRun(threadId) : undefined
    if (last && waitingOnHuman(last)) {
      addHumanReply(db, last.id,
        'I took over your screen and have handed it back. Look at where things are now and carry on.')
      requeue(last.id, botId)
    }
    return c.json({ ...(await r.json() as object), resumed: last && waitingOnHuman(last) ? last.id : null })
  })

  // The human's clipboard <-> the bot's X clipboard. The desktop client reads
  // and writes the host side; this moves the text across.
  app.get('/v1/bots/:id/clipboard', async (c) => {
    const rt = runtimeFor(c.req.param('id')) as LocalDockerRuntime
    const r = await fetch(await rt.shimUrl('/clipboard'))
    return c.json(await r.json(), r.status as 200)
  })

  app.post('/v1/bots/:id/clipboard', async (c) => {
    const rt = runtimeFor(c.req.param('id')) as LocalDockerRuntime
    const r = await fetch(await rt.shimUrl('/clipboard'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(await c.req.json()),
    })
    return c.json(await r.json(), r.status as 200)
  })

  app.post('/v1/bots/:id/computer/start', async (c) => {
    const rt = runtimeFor(c.req.param('id'))
    await rt.ensureUp()
    return c.json({ ok: true })
  })
}

type RunState = { id: string; state: string; state_reason: string | null }

/** Paused for a takeover, or stopped to ask the human something. */
const waitingOnHuman = (r: RunState) =>
  r.state === 'sleeping' || (r.state === 'blocked' && r.state_reason === 'ask_human')

/** On boot, put runs orphaned by the previous instance back in the queue. */
export function reclaimOrphanedRuns(db: Db, bus: EventBus): number {
  const orphans = db.prepare(
    "SELECT id, bot_id FROM runs WHERE state IN ('running') AND crash_count < 3",
  ).all() as Array<{ id: string; bot_id: string }>
  for (const o of orphans) {
    db.prepare("UPDATE runs SET state='queued', crash_count=crash_count+1 WHERE id=?").run(o.id)
  }
  // Re-queuing alone left them stranded: nothing drives a queued run but drive().
  const stranded = db.prepare(
    "SELECT id, bot_id FROM runs WHERE state = 'queued' AND crash_count < 3",
  ).all() as Array<{ id: string; bot_id: string }>
  db.prepare("UPDATE runs SET state='failed', state_reason='suspected_crash_loop' WHERE state='queued' AND crash_count>=3").run()
  for (const o of stranded) drive(db, bus, o.bot_id, o.id)
  if (stranded.length) log.warn({ count: stranded.length }, 'resumed runs left mid-flight by the previous instance')
  return orphans.length
}
