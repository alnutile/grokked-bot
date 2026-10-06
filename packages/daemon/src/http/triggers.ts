import type { Hono } from 'hono'
import type { Db } from '../db/index.ts'
import type { EventBus } from '../events.ts'
import { fire, triggers, type TriggerInput } from '../triggers.ts'
import * as tailscale from '../tailscale.ts'
import { drive } from './runs.ts'

/** Managing webhooks and schedules from the app, and the Tailscale switch. */
export function mountTriggers(app: Hono, db: Db, bus: EventBus): void {
  const bad = (e: unknown) => ({ error: 'bad_request', message: (e as Error).message })

  app.get('/v1/bots/:id/triggers', (c) => c.json({ triggers: triggers.list(db, c.req.param('id')) }))

  app.post('/v1/bots/:id/triggers', async (c) => {
    if (!db.prepare('SELECT 1 FROM bots WHERE id = ?').get(c.req.param('id'))) return c.json({ error: 'no_such_bot' }, 404)
    try { return c.json(triggers.create(db, c.req.param('id'), await c.req.json<TriggerInput>()), 201) }
    catch (e) { return c.json(bad(e), 400) }
  })

  app.patch('/v1/triggers/:id', async (c) => {
    try {
      const t = triggers.update(db, c.req.param('id'), await c.req.json<TriggerInput>())
      return t ? c.json({ trigger: t }) : c.json({ error: 'not_found' }, 404)
    } catch (e) { return c.json(bad(e), 400) }
  })

  app.delete('/v1/triggers/:id', (c) => { triggers.remove(db, c.req.param('id')); return c.json({ ok: true }) })

  /** A new token for a webhook; the old one stops working immediately. */
  app.post('/v1/triggers/:id/token', (c) => {
    const token = triggers.rotateToken(db, c.req.param('id'))
    return token ? c.json({ token }) : c.json({ error: 'not_found' }, 404)
  })

  /** Fire it now from the app, e.g. to try a schedule without waiting. */
  app.post('/v1/triggers/:id/run', async (c) => {
    const t = triggers.get(db, c.req.param('id'))
    if (!t) return c.json({ error: 'not_found' }, 404)
    const body = await c.req.json<{ prompt?: string; payload?: unknown }>().catch(() => ({}))
    const out = fire(db, bus, t, body, (botId, runId) => drive(db, bus, botId, runId))
    return 'error' in out
      ? c.json({ error: 'busy', message: 'this bot is working on something else' }, 409)
      : c.json({ ...out, thread_id: triggers.get(db, t.id)?.thread_id })
  })

  app.get('/v1/remote', async (c) => c.json(await tailscale.status()))

  app.post('/v1/remote/tailscale', async (c) => {
    const b = await c.req.json<{ serve?: boolean; funnel?: boolean }>()
    try {
      if (typeof b.serve === 'boolean') await tailscale.setServe(b.serve)
      if (typeof b.funnel === 'boolean') await tailscale.setFunnel(b.funnel)
      return c.json(await tailscale.status())
    } catch (e) { return c.json(bad(e), 400) }
  })
}
