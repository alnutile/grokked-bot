import type { Hono } from 'hono'
import { OPENROUTER_KEY, OPENROUTER_URL, setOpenRouterKey } from '../config.ts'
import { startPull, systemStatus } from '../runtime/docker.ts'

/**
 * First-run setup. On Linux these are all satisfied by the README's install
 * steps; on a Mac the app is the installer, so it needs to know what's missing
 * (Docker, the computer image, an OpenRouter key) and be able to fix the last two.
 */
export function mountSystem(app: Hono): void {
  app.get('/v1/system', async (c) =>
    c.json({ ...(await systemStatus()), openrouter_key: OPENROUTER_KEY !== '' }),
  )

  app.post('/v1/system/pull', async (c) => {
    await startPull()
    return c.json({ ok: true })
  })

  app.post('/v1/system/openrouter-key', async (c) => {
    const { key } = (await c.req.json().catch(() => ({}))) as { key?: string }
    const k = key?.trim() ?? ''
    if (!k) return c.json({ error: 'bad_request', message: 'key is required' }, 400)

    // Check it before saving, so a typo shows up here and not as a failed run.
    const res = await fetch(`${OPENROUTER_URL}/key`, {
      headers: { authorization: `Bearer ${k}` },
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null)
    if (res && res.status === 401) {
      return c.json({ error: 'invalid_key', message: 'OpenRouter rejected that key.' }, 400)
    }
    setOpenRouterKey(k)
    return c.json({ ok: true, verified: res?.ok ?? false })
  })
}
