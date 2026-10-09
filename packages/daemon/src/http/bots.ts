import { randomUUID } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { extname, join, relative, resolve, sep } from 'node:path'
import type { Hono } from 'hono'
import { DATA_DIR } from '../config.ts'
import type { Db } from '../db/index.ts'
import { botEnv, looksSecret, parseDotenv, toDotenv, type EnvVar } from '../env.ts'

type BotRow = {
  id: string; name: string; persona_md: string; description: string; avatar_json: string; model_roles_json: string
  default_domains_json: string; default_max_usd: number | null; created_at: number; env_enc?: string
  default_max_steps: number | null; default_max_wall_s: number | null
}

/** The wire shape: JSON columns parsed, so the UI never sees a stringly field. */
export const shapeBot = (b: BotRow) => {
  // env_enc stays out: it has its own endpoint, and the bot list goes everywhere.
  const { avatar_json, default_domains_json, model_roles_json, env_enc: _env, ...rest } = b
  return {
    ...rest,
    /** Overrides Settings for this bot; empty means use Settings. */
    worker_model: (JSON.parse(model_roles_json || '{}') as { worker?: string }).worker ?? '',
    avatar: JSON.parse(avatar_json || '{}') as { shape?: number; hue?: number },
    default_domains: JSON.parse(default_domains_json || '[]') as string[],
  }
}

export const getBot = (db: Db, id: string) => {
  const row = db.prepare('SELECT * FROM bots WHERE id = ?').get(id) as BotRow | undefined
  return row ? shapeBot(row) : undefined
}

/** Where the bot's container mounts /data/work. */
export const workDir = (botId: string) => join(DATA_DIR, 'bots', botId, 'work')

const MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8', '.json': 'application/json', '.html': 'text/html; charset=utf-8',
}

export function mountBots(app: Hono, db: Db): void {
  app.get('/v1/bots', (c) =>
    c.json({ bots: (db.prepare('SELECT * FROM bots ORDER BY created_at').all() as BotRow[]).map(shapeBot) }))

  app.post('/v1/bots', async (c) => {
    const body = await c.req.json<{ id?: string; name: string; persona_md?: string; description?: string }>()
    const t = Date.now()
    const id = body.id ?? `bot_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    const avatar = { shape: Math.floor(Math.random() * 4), hue: Math.floor(Math.random() * 360) }
    db.prepare(`INSERT INTO bots (id, name, persona_md, description, avatar_json, autonomy, status, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, 'supervised', 'active', ?, ?)`)
      .run(id, body.name, body.persona_md ?? '', body.description ?? '', JSON.stringify(avatar), t, t)
    return c.json({ bot: getBot(db, id) }, 201)
  })

  app.patch('/v1/bots/:id', async (c) => {
    const id = c.req.param('id')
    if (!getBot(db, id)) return c.json({ error: 'not_found' }, 404)
    const b = await c.req.json<{
      name?: string; description?: string; persona_md?: string
      default_domains?: string[]; default_max_usd?: number | null; avatar?: { shape: number; hue: number }
      default_max_steps?: number | null; default_max_wall_s?: number | null
      worker_model?: string
    }>()
    const sets: string[] = []
    const vals: Array<string | number | null> = []
    const put = (col: string, v: string | number | null) => { sets.push(`${col} = ?`); vals.push(v) }
    if (typeof b.name === 'string' && b.name.trim()) put('name', b.name.trim())
    if (typeof b.description === 'string') put('description', b.description)
    if (typeof b.persona_md === 'string') put('persona_md', b.persona_md)
    if (Array.isArray(b.default_domains)) put('default_domains_json', JSON.stringify(b.default_domains))
    if (b.default_max_usd === null || typeof b.default_max_usd === 'number') put('default_max_usd', b.default_max_usd)
    for (const k of ['default_max_steps', 'default_max_wall_s'] as const) {
      const v = b[k]
      if (v === null || (typeof v === 'number' && Number.isFinite(v) && v > 0)) put(k, v === null ? null : Math.round(v))
    }
    if (b.avatar) put('avatar_json', JSON.stringify(b.avatar))
    if (typeof b.worker_model === 'string') {
      put('model_roles_json', JSON.stringify(b.worker_model.trim() ? { worker: b.worker_model.trim() } : {}))
    }
    if (sets.length) {
      put('updated_at', Date.now())
      db.prepare(`UPDATE bots SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id)
    }
    return c.json({ bot: getBot(db, id) })
  })

  /** Its environment variables, values included: this API is the human's, behind the token. */
  const envBody = (vars: EnvVar[], skipped: string[] = []) => ({
    vars: vars.map((v) => ({ ...v, secret: looksSecret(v) })), text: toDotenv(vars), skipped,
  })
  app.get('/v1/bots/:id/env', (c) => {
    const id = c.req.param('id')
    if (!getBot(db, id)) return c.json({ error: 'not_found' }, 404)
    return c.json(envBody(botEnv.get(db, id)))
  })

  /** Replaces the whole set: `{text}` is a pasted .env file, `{vars}` a list. */
  app.put('/v1/bots/:id/env', async (c) => {
    const id = c.req.param('id')
    if (!getBot(db, id)) return c.json({ error: 'not_found' }, 404)
    const b = await c.req.json<{ text?: string; vars?: EnvVar[] }>()
    const parsed = typeof b.text === 'string' ? parseDotenv(b.text) : { vars: Array.isArray(b.vars) ? b.vars : [], skipped: [] }
    const saved = botEnv.set(db, id, parsed.vars)
    return c.json(envBody(saved.vars, [...parsed.skipped, ...saved.skipped]))
  })

  /** What the bot has made or downloaded, newest first. */
  app.get('/v1/bots/:id/files', async (c) => {
    const root = workDir(c.req.param('id'))
    const files: Array<{ path: string; abs: string; size: number; mtime: number }> = []
    const walk = async (dir: string, depth: number) => {
      if (depth > 4 || files.length >= 500) return
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
      for (const e of entries) {
        if (e.name.startsWith('.')) continue
        const abs = join(dir, e.name)
        if (e.isDirectory()) await walk(abs, depth + 1)
        else if (e.isFile()) {
          const s = await stat(abs).catch(() => null)
          if (s) files.push({ path: relative(root, abs), abs, size: s.size, mtime: s.mtimeMs })
        }
      }
    }
    await walk(root, 0)
    files.sort((a, b) => b.mtime - a.mtime)
    return c.json({ root, files })
  })

  app.get('/v1/bots/:id/files/raw', async (c) => {
    const root = resolve(workDir(c.req.param('id')))
    const abs = resolve(root, c.req.query('path') ?? '')
    // The path comes from the client; never serve anything outside the work dir.
    if (!abs.startsWith(root + sep)) return c.json({ error: 'bad_path' }, 400)
    const data = await readFile(abs).catch(() => null)
    if (!data) return c.json({ error: 'not_found' }, 404)
    return c.body(data, 200, { 'content-type': MIME[extname(abs).toLowerCase()] ?? 'application/octet-stream' })
  })
}
