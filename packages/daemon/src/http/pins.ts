import { randomUUID } from 'node:crypto'
import type { Hono } from 'hono'
import type { Db } from '../db/index.ts'

type Pin = { id: string; bot_id: string; thread_id: string | null; run_id: string | null; text: string; created_at: number; thread_title?: string | null }

/** Pinned responses: answers worth keeping, newest first, each linked back to its conversation. */
export function mountPins(app: Hono, db: Db): void {
  app.get('/v1/pins', (c) => {
    const thread = c.req.query('thread_id')
    const rows = (thread
      ? db.prepare('SELECT p.*, t.title AS thread_title FROM pins p LEFT JOIN threads t ON t.id = p.thread_id WHERE p.thread_id = ? ORDER BY p.created_at DESC').all(thread)
      : db.prepare('SELECT p.*, t.title AS thread_title FROM pins p LEFT JOIN threads t ON t.id = p.thread_id ORDER BY p.created_at DESC LIMIT 500').all()) as Pin[]
    return c.json({ pins: rows })
  })

  app.post('/v1/pins', async (c) => {
    const b = await c.req.json<{ bot_id?: string; thread_id?: string; run_id?: string; text?: string }>()
    if (!b.bot_id || !db.prepare('SELECT 1 FROM bots WHERE id = ?').get(b.bot_id)) return c.json({ error: 'no_such_bot' }, 404)
    if (!b.text?.trim()) return c.json({ error: 'bad_request', message: 'nothing to pin' }, 400)
    // Pinning the same response twice returns the existing pin.
    const same = db.prepare('SELECT * FROM pins WHERE bot_id = ? AND thread_id IS ? AND text = ?').get(b.bot_id, b.thread_id ?? null, b.text) as Pin | undefined
    if (same) return c.json({ pin: same })
    const id = `pin_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    db.prepare('INSERT INTO pins (id, bot_id, thread_id, run_id, text, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, b.bot_id, b.thread_id ?? null, b.run_id ?? null, b.text, Date.now())
    return c.json({ pin: db.prepare('SELECT * FROM pins WHERE id = ?').get(id) }, 201)
  })

  app.delete('/v1/pins/:id', (c) => {
    db.prepare('DELETE FROM pins WHERE id = ?').run(c.req.param('id'))
    return c.json({ ok: true })
  })
}
