import { Hono, type Context } from 'hono'
import type { Db } from '../db/index.ts'
import type { EventBus } from '../events.ts'
import { botBusy, fire, triggers } from '../triggers.ts'
import { drive } from './runs.ts'

/**
 * The webhook listener. It serves nothing but /hooks, so exposing it (Tailscale
 * serve, Funnel, or any tunnel) never exposes the rest of the API.
 *
 *   POST /hooks/<id>           reachable on the tailnet (or wherever you put it)
 *   POST /public/hooks/<id>    the same, but only for hooks marked public; this
 *                              is the path Tailscale Funnel maps to
 *   GET  .../hooks/<id>/runs/<run_id>   status of a run it started
 *
 * Auth is the hook's own bearer token. The body is {prompt?, payload?, wait?};
 * any other JSON is taken whole as the payload, so services that post their own
 * shape (GitHub, Stripe, n8n) work unchanged. ?wait=<seconds> or "wait" holds the
 * request open (up to 300s) and returns the answer.
 */

const MAX_BODY = 256 * 1024
const MAX_WAIT_S = 300
const DONE = new Set(['succeeded', 'failed', 'blocked', 'paused_budget', 'cancelled', 'sleeping'])

type RunRow = { id: string; state: string; state_reason: string | null; outcome_summary: string | null; step_no: number; spend_usd: number }

const view = (r: RunRow) => ({
  run_id: r.id,
  state: r.state,
  ...(r.state === 'succeeded' ? { answer: r.outcome_summary } : {}),
  ...(r.state === 'blocked' && r.state_reason === 'ask_human' ? { question: r.outcome_summary } : {}),
  ...(r.state === 'failed' ? { reason: r.state_reason } : {}),
  steps: r.step_no,
  spend_usd: Number(r.spend_usd.toFixed(4)),
})

export function createHooksApp(db: Db, bus: EventBus): Hono {
  const app = new Hono()
  const start = (botId: string, runId: string) => drive(db, bus, botId, runId)
  const getRun = (id: string) => db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as RunRow | undefined

  /** The hook, if this request may use it; otherwise the response to send. */
  const authorize = (c: Context, isPublic: boolean) => {
    const id = c.req.param('id') ?? ''
    const t = triggers.get(db, id)
    if (!t || t.kind !== 'webhook' || !t.enabled) return { res: c.json({ error: 'not_found' }, 404) }
    const auth = c.req.header('authorization') ?? ''
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
    if (!triggers.tokenMatches(db, id, token)) return { res: c.json({ error: 'unauthorized', message: 'missing or wrong bearer token' }, 401) }
    // Checked after the token so a public probe can't learn which hooks exist.
    if (isPublic && !t.public) return { res: c.json({ error: 'not_public', message: 'this hook is only reachable on the tailnet' }, 403) }
    return { t }
  }

  const post = async (c: Context, isPublic: boolean) => {
    const a = authorize(c, isPublic)
    if (!a.t) return a.res
    const raw = await c.req.text()
    if (raw.length > MAX_BODY) return c.json({ error: 'too_large', message: `body over ${MAX_BODY} bytes` }, 413)
    let body: unknown = raw
    try { body = raw ? JSON.parse(raw) : {} } catch { /* plain text: it's the payload */ }
    let prompt: string | undefined
    let payload: unknown = body
    let wait = Number(c.req.query('wait') ?? 0)
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      const o = body as Record<string, unknown>
      const keys = Object.keys(o)
      if (keys.length && keys.every((k) => ['prompt', 'payload', 'wait'].includes(k))) {
        prompt = typeof o.prompt === 'string' ? o.prompt : undefined
        payload = o.payload
        if (typeof o.wait === 'number') wait = o.wait
      } else if (!keys.length) payload = undefined
    }
    wait = Math.max(0, Math.min(MAX_WAIT_S, Number.isFinite(wait) ? wait : 0))

    const out = fire(db, bus, a.t, { prompt, payload }, start)
    if ('error' in out) {
      return c.json({ error: 'busy', message: 'this bot is working on something else; try again shortly' }, 409, { 'retry-after': '30' })
    }
    const status = `${isPublic ? '/public' : ''}/hooks/${a.t.id}/runs/${out.run_id}`
    const deadline = Date.now() + wait * 1000
    while (Date.now() < deadline) {
      const r = getRun(out.run_id)
      if (r && DONE.has(r.state)) return c.json(view(r), 200)
      await new Promise((res) => setTimeout(res, 1000))
    }
    const r = getRun(out.run_id)
    if (r && DONE.has(r.state)) return c.json(view(r), 200)
    return c.json({ run_id: out.run_id, state: r?.state ?? 'queued', status_url: status }, 202)
  }

  const status = (c: Context, isPublic: boolean) => {
    const a = authorize(c, isPublic)
    if (!a.t) return a.res
    const r = getRun(c.req.param('runId') ?? '')
    const owned = r && db.prepare('SELECT 1 FROM runs WHERE id = ? AND trigger_id = ?').get(r.id, a.t.id)
    return r && owned ? c.json(view(r)) : c.json({ error: 'not_found' }, 404)
  }

  app.post('/hooks/:id', (c) => post(c, false))
  app.post('/public/hooks/:id', (c) => post(c, true))
  app.get('/hooks/:id/runs/:runId', (c) => status(c, false))
  app.get('/public/hooks/:id/runs/:runId', (c) => status(c, true))
  app.notFound((c) => c.json({ error: 'not_found' }, 404))
  return app
}

export { botBusy }
