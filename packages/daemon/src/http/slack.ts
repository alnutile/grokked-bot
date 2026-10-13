import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Hono } from 'hono'
import type { Db } from '../db/index.ts'
import { getBot } from './bots.ts'
import { checkTokens, slack, slackManifest, slackStore, type SlackUser } from '../slack.ts'

/** A bot's Slack app: the manifest to create it, its tokens, who may use it. Tokens never come back out. */
export function mountSlack(app: Hono, db: Db): void {
  const view = (botId: string, color?: string) => {
    const bot = getBot(db, botId)!
    const r = slackStore.get(db, botId)
    return {
      manifest: slackManifest(bot, color),
      configured: !!r,
      enabled: !!r?.enabled,
      team_id: r?.team_id ?? null,
      team_name: r?.team_name ?? null,
      team_url: r?.team_url ?? null,
      bot_user_id: r?.bot_user_id ?? null,
      bot_user_name: r?.bot_user_name ?? null,
      app_id: r?.app_id ?? null,
      allow_all: !!r?.allow_all,
      allowed_users: r ? slackStore.users(r) : [],
      status: slack.status(botId),
    }
  }

  app.get('/v1/bots/:id/slack', (c) => {
    const id = c.req.param('id')
    if (!getBot(db, id)) return c.json({ error: 'not_found' }, 404)
    return c.json(view(id, c.req.query('color')))
  })

  /** Connect (or reconnect with new tokens). Both are checked with Slack before saving. */
  app.put('/v1/bots/:id/slack', async (c) => {
    const id = c.req.param('id')
    if (!getBot(db, id)) return c.json({ error: 'not_found' }, 404)
    const b = await c.req.json<{ bot_token?: string; app_token?: string }>()
    const old = slackStore.get(db, id)
    const tokens = old ? slackStore.tokens(old) : null
    const botToken = (b.bot_token ?? '').trim() || tokens?.bot || ''
    const appToken = (b.app_token ?? '').trim() || tokens?.app || ''
    const check = await checkTokens(botToken, appToken)
    if (!check.ok) return c.json({ error: 'bad_tokens', message: check.message }, 400)
    // A different workspace or app means a different set of people.
    if (old && old.team_id !== check.team_id) slackStore.setAccess(db, id, false, [])
    slackStore.save(db, id, { bot_token: botToken, app_token: appToken, ...check })
    slack.restart(id)
    await new Promise((r) => setTimeout(r, 1500)) // usually connected by now, so the UI can say so
    return c.json(view(id))
  })

  app.patch('/v1/bots/:id/slack', async (c) => {
    const id = c.req.param('id')
    if (!slackStore.get(db, id)) return c.json({ error: 'not_found' }, 404)
    const b = await c.req.json<{ enabled?: boolean; allow_all?: boolean; allowed_users?: SlackUser[] }>()
    const r = slackStore.get(db, id)!
    if (b.allow_all !== undefined || b.allowed_users) {
      const users = Array.isArray(b.allowed_users)
        ? b.allowed_users.filter((u) => /^[UW][A-Z0-9]+$/.test(String(u?.id))).map((u) => ({ id: u.id, name: String(u.name ?? u.id).slice(0, 80) }))
        : slackStore.users(r)
      slackStore.setAccess(db, id, b.allow_all ?? !!r.allow_all, users)
    }
    if (b.enabled !== undefined) { slackStore.setEnabled(db, id, b.enabled); slack.restart(id) }
    return c.json(view(id))
  })

  app.delete('/v1/bots/:id/slack', (c) => {
    const id = c.req.param('id')
    slackStore.remove(db, id)
    slack.restart(id)
    return c.json(view(id))
  })

  /** The bot's face as a PNG for the Slack app icon, saved to ~/Downloads. */
  app.post('/v1/bots/:id/slack/icon', async (c) => {
    const id = c.req.param('id')
    const bot = getBot(db, id)
    if (!bot) return c.json({ error: 'not_found' }, 404)
    const { png } = await c.req.json<{ png?: string }>()
    const data = Buffer.from(String(png ?? '').replace(/^data:image\/png;base64,/, ''), 'base64')
    if (data.length < 100 || data.subarray(1, 4).toString() !== 'PNG') return c.json({ error: 'bad_png' }, 400)
    const dir = join(homedir(), 'Downloads')
    mkdirSync(dir, { recursive: true })
    const path = join(dir, `${bot.name.replace(/[^A-Za-z0-9 _-]+/g, '').trim() || 'bot'} Slack icon.png`)
    writeFileSync(path, data)
    return c.json({ path })
  })
}
