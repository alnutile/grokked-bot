import type { Hono } from 'hono'
import { loadConfig, OPENROUTER_KEY, OPENROUTER_URL, saveConfig } from '../config.ts'
import type { Db } from '../db/index.ts'
import { vault, type CredentialInput } from '../vault.ts'

interface ModelInfo { id: string; name: string; context_length: number; prompt_per_m: number; completion_per_m: number }

/** OpenRouter's tool-capable models, for the model pickers. Cached: the list is
 *  large and changes slowly. */
let modelCache: { at: number; models: ModelInfo[] } | null = null
async function toolModels(): Promise<ModelInfo[]> {
  if (modelCache && Date.now() - modelCache.at < 3600_000) return modelCache.models
  const res = await fetch(`${OPENROUTER_URL}/models?supported_parameters=tools`, {
    headers: { authorization: `Bearer ${OPENROUTER_KEY}` },
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`OpenRouter /models answered ${res.status}`)
  const data = ((await res.json()) as any).data as any[]
  const models = data.map((m) => ({
    id: String(m.id), name: String(m.name ?? m.id), context_length: Number(m.context_length ?? 0),
    prompt_per_m: Number(m.pricing?.prompt ?? 0) * 1e6, completion_per_m: Number(m.pricing?.completion ?? 0) * 1e6,
  })).sort((a, b) => a.id.localeCompare(b.id))
  modelCache = { at: Date.now(), models }
  return models
}

export function mountSettings(app: Hono, db: Db): void {
  app.get('/v1/settings', (c) => c.json(loadConfig()))

  app.patch('/v1/settings', async (c) => {
    const body = await c.req.json<Parameters<typeof saveConfig>[0]>()
    const d = body.defaults ?? {}
    for (const [k, v] of Object.entries(d)) {
      if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return c.json({ error: 'bad_value', message: `${k} must be a positive number` }, 400)
    }
    for (const [k, v] of Object.entries(body.models ?? {})) {
      if (typeof v !== 'string' || !v.trim()) return c.json({ error: 'bad_value', message: `${k} needs a model id` }, 400)
    }
    return c.json(saveConfig(body))
  })

  app.get('/v1/models', async (c) => {
    try { return c.json({ models: await toolModels() }) }
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
