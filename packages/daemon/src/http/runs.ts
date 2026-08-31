import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import type { Db } from '../db/index.ts'
import type { EventBus } from '../events.ts'
import { createRun, executeStep } from '../agent/loop.ts'
import { LocalDockerRuntime, type BotRuntime } from '../runtime/container.ts'
import { log } from '../log.ts'

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
  app.get('/v1/bots', (c) =>
    c.json({ bots: db.prepare('SELECT * FROM bots ORDER BY created_at').all() }))

  app.post('/v1/bots', async (c) => {
    const body = await c.req.json<{ id?: string; name: string; persona_md?: string }>()
    const t = Date.now()
    const id = body.id ?? `bot_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    db.prepare(`INSERT INTO bots (id, name, persona_md, autonomy, status, created_at, updated_at)
                VALUES (?, ?, ?, 'supervised', 'active', ?, ?)`)
      .run(id, body.name, body.persona_md ?? '', t, t)
    return c.json({ bot: db.prepare('SELECT * FROM bots WHERE id=?').get(id) }, 201)
  })

  app.post('/v1/runs', async (c) => {
    const body = await c.req.json<{
      bot_id: string; goal: string; allowed_domains?: string[]
      max_steps?: number; max_usd?: number
    }>()
    if (!db.prepare('SELECT 1 FROM bots WHERE id=?').get(body.bot_id)) {
      return c.json({ error: 'no_such_bot', message: `no bot ${body.bot_id}` }, 404)
    }
    const runId = createRun(db, body)
    bus.emit({ topic: `bot:${body.bot_id}`, type: 'run.created', run_id: runId,
               bot_id: body.bot_id, data: { run_id: runId, goal: body.goal } })
    drive(db, bus, body.bot_id, runId)
    return c.json({ run: db.prepare('SELECT * FROM runs WHERE id=?').get(runId) }, 201)
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

  /** Resume anything left mid-flight by a restart. The loop cannot tell the
   *  difference between this and a normal step, which is the point. */
  app.post('/v1/runs/:id/resume', (c) => {
    const id = c.req.param('id')
    const run = db.prepare('SELECT bot_id, state FROM runs WHERE id=?').get(id) as
      { bot_id: string; state: string } | undefined
    if (!run) return c.json({ error: 'not_found' }, 404)
    db.prepare("UPDATE runs SET state='running' WHERE id=?").run(id)
    drive(db, bus, run.bot_id, id)
    return c.json({ ok: true, resumed: id })
  })

  app.get('/v1/bots/:id/computer', (c) =>
    c.json({ vnc_url: (runtimeFor(c.req.param('id')) as LocalDockerRuntime).vncUrl() }))
}

/** On boot, put runs orphaned by the previous instance back in the queue. */
export function reclaimOrphanedRuns(db: Db, bus: EventBus): number {
  const orphans = db.prepare(
    "SELECT id, bot_id FROM runs WHERE state IN ('running') AND crash_count < 3",
  ).all() as Array<{ id: string; bot_id: string }>
  for (const o of orphans) {
    db.prepare("UPDATE runs SET state='queued', crash_count=crash_count+1 WHERE id=?").run(o.id)
  }
  db.prepare("UPDATE runs SET state='failed', state_reason='suspected_crash_loop' WHERE state='queued' AND crash_count>=3").run()
  if (orphans.length) log.warn({ count: orphans.length }, 'reclaimed runs orphaned by previous instance')
  return orphans.length
}
