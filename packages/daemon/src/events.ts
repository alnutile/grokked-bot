import { PROTOCOL_VERSION, type ServerFrame } from '@grokked/protocol'
import type { Db } from './db/index.ts'
import { EVENT_RETENTION_MS } from './config.ts'

export type Subscriber = (frame: ServerFrame) => void

export interface EmitInput {
  topic: string
  type: string
  data: unknown
  bot_id?: string | null
  run_id?: string | null
}

/**
 * The WS is a cache-invalidation channel, never the source of truth: every frame
 * is durably appended here first, so a reconnecting client can replay `seq >
 * since` and rebuild state. Retrofitting this later means auditing every consumer
 * for lost-update bugs, so it exists from the first milestone.
 */
export class EventBus {
  #db: Db
  #subs = new Set<Subscriber>()

  constructor(db: Db) {
    this.#db = db
  }

  subscribe(fn: Subscriber): () => void {
    this.#subs.add(fn)
    return () => this.#subs.delete(fn)
  }

  emit(input: EmitInput): ServerFrame {
    const ts = Date.now()
    const info = this.#db
      .prepare(
        `INSERT INTO events (topic, type, bot_id, run_id, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(input.topic, input.type, input.bot_id ?? null, input.run_id ?? null, JSON.stringify(input.data ?? null), ts)

    const frame: ServerFrame = {
      v: PROTOCOL_VERSION,
      seq: Number(info.lastInsertRowid),
      ts,
      type: input.type,
      topic: input.topic,
      data: input.data,
    }
    for (const fn of this.#subs) {
      try {
        fn(frame)
      } catch {
        /* a broken subscriber must never break the emitter */
      }
    }
    return frame
  }

  /** Frames for `topics` newer than `since`, oldest first. */
  replay(topics: string[], since: number, limit = 2000): ServerFrame[] {
    if (topics.length === 0) return []
    const placeholders = topics.map(() => '?').join(',')
    const rows = this.#db
      .prepare(
        `SELECT seq, topic, type, payload_json, created_at
           FROM events
          WHERE seq > ? AND topic IN (${placeholders})
          ORDER BY seq ASC
          LIMIT ?`,
      )
      .all(since, ...topics, limit) as Array<{
      seq: number
      topic: string
      type: string
      payload_json: string
      created_at: number
    }>

    return rows.map((r) => ({
      v: PROTOCOL_VERSION,
      seq: Number(r.seq),
      ts: Number(r.created_at),
      type: r.type,
      topic: r.topic,
      data: JSON.parse(r.payload_json) as unknown,
    }))
  }

  serverSeq(): number {
    const row = this.#db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM events').get() as { seq: number }
    return Number(row.seq)
  }

  /** True when `since` predates retention, so replay would silently lose frames. */
  hasGap(since: number): boolean {
    if (since <= 0) return false
    const row = this.#db.prepare('SELECT COALESCE(MIN(seq), 0) AS seq FROM events').get() as { seq: number }
    return Number(row.seq) > since + 1
  }

  pruneOlderThanRetention(): number {
    const cutoff = Date.now() - EVENT_RETENTION_MS
    return Number(this.#db.prepare('DELETE FROM events WHERE created_at < ?').run(cutoff).changes)
  }
}
