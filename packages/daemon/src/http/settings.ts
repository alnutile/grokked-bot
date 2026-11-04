import type { Hono } from 'hono'
import { loadConfig, saveConfig, providerKey, setProviderKey } from '../config.ts'
import type { Db } from '../db/index.ts'
import { toolModels } from '../model/catalog.ts'
import { vault, type CredentialInput } from '../vault.ts'

export function mountSettings(app: Hono, db: Db): void {
  app.get('/v1/settings', (c) => c.json(loadConfig()))

  app.get('/v1/providers', c => c.json({ providers: ['openrouter', 'openai', 'local'].map(id => ({ id, has_key: !!providerKey(id) })) }))
  app.put('/v1/providers/:provider/key', async c => {
    const provider = c.req.param('provider')
    const { key } = await c.req.json()
    if (!['openrouter', 'openai', 'local'].includes(provider) || typeof key !== 'string' || /[\r\n\x00]/.test(key)) return c.json({ error: 'bad_value' }, 400)
    setProviderKey(provider, key.trim())
    return c.json({ ok: true })
  })
  app.get('/v1/usage', c => c.json({ rows: db.prepare(`
    SELECT COALESCE(l.bot_id, r.bot_id) AS bot_id, COALESCE(b.name, 'Unattributed') AS bot_name,
      COALESCE(l.provider, 'openrouter') AS provider, l.model, l.role, COUNT(*) AS calls,
      SUM(COALESCE(l.prompt_tokens, 0)) AS input_tokens, SUM(COALESCE(l.completion_tokens, 0)) AS output_tokens,
      SUM(COALESCE(l.cached_tokens, 0)) AS cached_tokens, SUM(COALESCE(l.cost_usd, 0)) AS reported_cost_usd,
      SUM(CASE WHEN l.cost_known = 0 THEN 1 ELSE 0 END) AS unknown_cost_calls,
      SUM(CASE WHEN l.usage_known = 0 THEN 1 ELSE 0 END) AS unknown_usage_calls
    FROM llm_calls l LEFT JOIN runs r ON r.id = l.run_id LEFT JOIN bots b ON b.id = COALESCE(l.bot_id, r.bot_id)
    GROUP BY COALESCE(l.bot_id, r.bot_id), l.provider, l.model, l.role ORDER BY reported_cost_usd DESC
  `).all() }))

  app.patch('/v1/settings', async (c) => {
    const body = await c.req.json<Parameters<typeof saveConfig>[0]>()
    if (body.local_url !== undefined) {
      try {
        const url = new URL(body.local_url)
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error()
      } catch { return c.json({ error: 'bad_value', message: 'Use an HTTP(S) base URL without credentials, query or fragment' }, 400) }
    }
    const d = body.defaults ?? {}
    for (const [k, v] of Object.entries(d)) {
      if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return c.json({ error: 'bad_value', message: `${k} must be a positive number` }, 400)
    }
    for (const [k, v] of Object.entries(body.models ?? {})) {
      if (typeof v !== 'string' || (k !== 'vision' && !v.trim())) return c.json({ error: 'bad_value', message: `${k} needs a model id` }, 400)
    }
    if (body.instructions !== undefined && typeof body.instructions !== 'string') return c.json({ error: 'bad_value', message: 'instructions must be text' }, 400)
    if ((body.instructions ?? '').length > 20_000) return c.json({ error: 'bad_value', message: 'instructions are limited to 20,000 characters' }, 400)
    return c.json(saveConfig(body))
  })

  app.get('/v1/models', async (c) => {
    try { return c.json({ models: await toolModels(c.req.query('provider') === 'local' ? 'local' : c.req.query('provider') === 'openai' ? 'openai' : 'openrouter') }) }
    catch (e) { return c.json({ error: 'unavailable', message: (e as Error).message }, 502) }
  })

  // ---- saved logins. Secrets go in, but only /reveal ever sends one back out.
  app.get('/v1/credentials', (c) => c.json({ credentials: vault.list(db) }))

  app.post('/v1/credentials', async (c) => {
    try { return c.json({ credential: vault.create(db, await c.req.json<CredentialInput>()) }, 201) }
    catch (e) { return c.json({ error: 'bad_request', message: (e as Error).message }, 400) }
  })

  app.patch('/v1/credentials/:id', async (c) => {
    const r = vault.update(db, c.req.param('id'), await c.req.json<CredentialInput>())
    return r ? c.json({ credential: r }) : c.json({ error: 'not_found' }, 404)
  })

  app.delete('/v1/credentials/:id', (c) => {
    vault.remove(db, c.req.param('id'))
    return c.json({ ok: true })
  })

  app.get('/v1/credentials/:id/reveal', (c) => {
    const secret = vault.reveal(db, c.req.param('id'))
    return secret === null ? c.json({ error: 'not_found' }, 404) : c.json({ password: secret })
  })
}
