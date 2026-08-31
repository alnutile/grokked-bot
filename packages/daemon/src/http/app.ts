import { timingSafeEqual } from 'node:crypto'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { Health } from '@grokked/protocol'
import { INSTANCE_ID, VERSION } from '../config.ts'
import { PROTOCOL_VERSION } from '@grokked/protocol'
import { dbOk, type Db } from '../db/index.ts'
import type { EventBus } from '../events.ts'

export interface AppDeps {
  db: Db
  bus: EventBus
  token: string
  startedAt: number
}

function safeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono()

  // The UI is served from http://localhost:<port> (tauri-plugin-localhost) while
  // the daemon is on 127.0.0.1:8787 -- different origins, so every call is a CORS
  // request. Must come BEFORE the bearer check: a preflight carries no
  // Authorization header, so auth would 401 it and the browser would never send
  // the real request.
  app.use('/v1/*', cors({
    origin: (o) => (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o) ? o : null),
    allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['authorization', 'content-type'],
    maxAge: 600,
  }))

  app.use('/v1/*', async (c, next) => {
    if (c.req.method === 'OPTIONS') return next()
    // Webhook ingress authenticates per-trigger with HMAC instead of the bearer token.
    if (c.req.path.startsWith('/v1/hooks/')) return next()

    const header = c.req.header('authorization') ?? ''
    const provided = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
    if (!provided || !safeEq(provided, deps.token)) {
      return c.json({ error: 'unauthorized', message: 'missing or invalid bearer token' }, 401)
    }
    return next()
  })

  app.get('/v1/health', (c) => {
    const activeRuns = deps.db
      .prepare(`SELECT COUNT(*) AS n FROM runs WHERE state IN ('running','queued','sleeping','awaiting_approval')`)
      .get() as { n: number }
    const pending = deps.db
      .prepare(`SELECT COUNT(*) AS n FROM approvals WHERE state = 'pending'`)
      .get() as { n: number }

    const body: Health = {
      ok: true,
      version: VERSION,
      protocol: PROTOCOL_VERSION,
      instance_id: INSTANCE_ID,
      uptime_s: Math.round((Date.now() - deps.startedAt) / 1000),
      db_ok: dbOk(deps.db),
      active_runs: Number(activeRuns.n),
      pending_approvals: Number(pending.n),
      server_seq: deps.bus.serverSeq(),
    }
    return c.json(body)
  })

  app.notFound((c) => c.json({ error: 'not_found', message: `no route for ${c.req.path}` }, 404))

  app.onError((err, c) =>
    c.json({ error: 'internal', message: err.message }, 500),
  )

  return app
}
