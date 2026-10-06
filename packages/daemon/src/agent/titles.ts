import type { Db } from '../db/index.ts'
import type { EventBus } from '../events.ts'
import { loadConfig } from '../config.ts'
import { log } from '../log.ts'
import { chat } from '../model/openrouter.ts'

/** The first few words, so a conversation has a name even if the model call fails. */
export const fallbackTitle = (text: string): string => {
  const words = text.replace(/\s+/g, ' ').trim().split(' ')
  return words.slice(0, 7).join(' ') + (words.length > 7 ? '…' : '')
}

/**
 * Names a conversation from its first message with the cheap classifier model.
 * Fire-and-forget: the run never waits on it, and a human-set title always wins.
 */
export function autoTitle(db: Db, bus: EventBus, threadId: string, botId: string, firstMessage: string): void {
  const set = (title: string) => {
    const r = db.prepare(
      `UPDATE threads SET title = ? WHERE id = ? AND title_source = 'auto'`,
    ).run(title.slice(0, 120), threadId)
    if (r.changes) bus.emit({ topic: `bot:${botId}`, type: 'thread.updated', data: { thread_id: threadId, title } })
  }
  set(fallbackTitle(firstMessage))

  void (async () => {
    try {
      const res = await chat({
        model: loadConfig().models.classifier,
        max_tokens: 24,
        temperature: 0.2,
        messages: [
          { role: 'system', content: 'Name this conversation in 3 to 6 words, Title Case, no quotes or trailing punctuation. Reply with the title only.' },
          { role: 'user', content: firstMessage.slice(0, 2000) },
        ],
      })
      const title = (res.content ?? '').replace(/^["'\s]+|["'.\s]+$/g, '').split('\n')[0]!
      if (title) set(title)
    } catch (e) {
      log.warn({ threadId, err: (e as Error).message }, 'auto title failed; keeping fallback')
    }
  })()
}

/** Conversations from before automatic titles carry their whole first message
 *  as a title, or none. Name those once; anything a human renamed is left alone. */
export function backfillTitles(db: Db, bus: EventBus): void {
  const rows = db.prepare(
    `SELECT t.id, t.bot_id,
            (SELECT r.goal FROM runs r WHERE r.thread_id = t.id ORDER BY r.created_at LIMIT 1) AS first
     FROM threads t
     WHERE t.kind = 'chat' AND t.title_source = 'auto'
       AND (t.title IS NULL OR t.title = '' OR length(t.title) > 60)`,
  ).all() as Array<{ id: string; bot_id: string; first: string | null }>
  for (const r of rows) if (r.first) autoTitle(db, bus, r.id, r.bot_id, r.first)
}
