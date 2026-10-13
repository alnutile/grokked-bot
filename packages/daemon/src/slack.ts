import { randomUUID } from 'node:crypto'
import type { Db } from './db/index.ts'
import type { EventBus } from './events.ts'
import { decrypt, encrypt } from './vault.ts'
import { log } from './log.ts'

/**
 * Slack, per bot. Each bot gets its own Slack app (its name, its face), connected
 * over Socket Mode: the daemon holds a WebSocket out to Slack, so there is no
 * public URL, tunnel or webhook to set up, and it works from a laptop on any
 * network.
 *
 * A DM, an @mention, or a reply in a thread the bot is already in becomes a
 * message to the bot in a conversation of its own (kind 'slack'), through the
 * same path as the app's chat box. To feel fast it reacts 👀 at once, posts
 * "On it…", edits that message with what it's doing as it works, and replaces it
 * with the answer. A question it asks (ask_human) is posted in the thread, and
 * the reply there carries the run on.
 *
 * Who may use it: the people on its list. The first person to message a newly
 * connected bot is added (that's you, setting it up); "Anyone in the workspace"
 * opens it up.
 */

export interface SlackUser { id: string; name: string }
export interface SlackRow {
  bot_id: string; bot_token_enc: string; app_token_enc: string
  team_id: string | null; team_name: string | null; team_url: string | null
  bot_user_id: string | null; bot_user_name: string | null; app_id: string | null
  enabled: number; allow_all: number; allowed_users_json: string
}
export type SlackStatus = { state: 'off' | 'connecting' | 'connected' | 'error'; detail?: string; since: number }

// ---------------------------------------------------------------- the manifest

const SCOPES = [
  'app_mentions:read', 'chat:write', 'im:history', 'im:read', 'im:write',
  'channels:history', 'groups:history', 'mpim:history', 'reactions:write', 'users:read', 'files:write',
]
const EVENTS = ['app_mention', 'message.im', 'message.channels', 'message.groups', 'message.mpim']

const yamlStr = (s: string) => JSON.stringify(s)

/** The app manifest to paste into api.slack.com/apps → Create New App → From a manifest. */
export function slackManifest(bot: { name: string; description?: string | null; persona_md?: string | null }, color = '#4a5bd4'): string {
  const name = bot.name.trim().slice(0, 35) || 'Grokked Bot'
  const firstLine = [bot.description ?? '', bot.persona_md ?? ''].join('\n').split('\n').map((l) => l.trim()).find(Boolean) ?? ''
  const description = (firstLine || `${name}, an AI teammate with its own computer (Grokked Bot).`).slice(0, 139)
  const handle = name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'grokked-bot'
  return [
    'display_information:',
    `  name: ${yamlStr(name)}`,
    `  description: ${yamlStr(description)}`,
    `  background_color: ${yamlStr(/^#[0-9a-f]{6}$/i.test(color) ? color : '#4a5bd4')}`,
    'features:',
    '  app_home:',
    '    home_tab_enabled: false',
    '    messages_tab_enabled: true',
    '    messages_tab_read_only_enabled: false',
    '  bot_user:',
    `    display_name: ${yamlStr(handle)}`,
    '    always_online: true',
    'oauth_config:',
    '  scopes:',
    '    bot:',
    ...SCOPES.map((s) => `      - ${s}`),
    'settings:',
    '  event_subscriptions:',
    '    bot_events:',
    ...EVENTS.map((e) => `      - ${e}`),
    '  interactivity:',
    '    is_enabled: false',
    '  org_deploy_enabled: false',
    '  socket_mode_enabled: true',
    '  token_rotation_enabled: false',
    '',
  ].join('\n')
}

// ---------------------------------------------------------------- text both ways

const unescape = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

/** Slack's markup to plain text: <@U1> → @Name, <#C1|general> → #general, <url|label> → label (url). */
export function slackToText(text: string, names: Record<string, string> = {}, botUserId?: string): string {
  return unescape(
    text
      .replace(/<@([A-Z0-9]+)(?:\|[^>]*)?>/g, (_, id: string) => (id === botUserId ? '' : `@${names[id] ?? id}`))
      .replace(/<#[A-Z0-9]+\|([^>]*)>/g, '#$1')
      .replace(/<!(here|channel|everyone)>/g, '@$1')
      .replace(/<(https?:[^|>]+)\|([^>]+)>/g, (_, url: string, label: string) => (label === url ? url : `${label} (${url})`))
      .replace(/<(mailto:)?([^>|]+)>/g, '$2'),
  ).replace(/[ \t]+/g, ' ').trim()
}

/** The model's Markdown to Slack's mrkdwn. Code blocks are left alone. */
export function toMrkdwn(md: string): string {
  return md.split(/(```[\s\S]*?```)/g).map((part, i) => {
    if (i % 2) return part.replace(/^```[a-zA-Z0-9_+-]*\n/, '```\n')
    return part
      .split(/(`[^`\n]+`)/g).map((p, j) => (j % 2 ? p : p
        .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '<$2|$1>')
        .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<$2|$1>')
        .replace(/^#{1,6}\s+(.+)$/gm, '*$1*')
        .replace(/\*\*([^*\n]+)\*\*/g, '*$1*')
        .replace(/__([^_\n]+)__/g, '*$1*')
        .replace(/~~([^~\n]+)~~/g, '~$1~')
        .replace(/^(\s*)[-*] /gm, '$1• ')))
      .join('')
  }).join('')
}

// ---------------------------------------------------------------- which messages are for the bot

export interface SlackEvent {
  type: string; subtype?: string; user?: string; bot_id?: string; text?: string
  channel?: string; channel_type?: string; ts?: string; thread_ts?: string
}

/**
 * Whether the bot should answer: a DM, an @mention, or a reply in a thread it's
 * already in. Its own posts, other bots, edits and joins are not messages to it.
 */
export function isForBot(e: SlackEvent, botUserId: string | null, inKnownThread: boolean): boolean {
  if (!e.user || !e.channel || !e.ts || e.bot_id || e.user === botUserId) return false
  if (e.subtype && e.subtype !== 'file_share' && e.subtype !== 'thread_broadcast') return false
  if (!slackToText(e.text ?? '', {}, botUserId ?? undefined)) return false
  if (e.type === 'app_mention') return true
  if (e.type !== 'message') return false
  if (e.channel_type === 'im') return true
  if (botUserId && (e.text ?? '').includes(`<@${botUserId}>`)) return true // the app_mention twin; deduped by ts
  return inKnownThread
}

// ---------------------------------------------------------------- storage

const DM_FRESH_MS = 4 * 60 * 60 * 1000

export const slackStore = {
  get(db: Db, botId: string): SlackRow | undefined {
    return db.prepare('SELECT * FROM slack_apps WHERE bot_id = ?').get(botId) as SlackRow | undefined
  },
  all(db: Db): SlackRow[] {
    return db.prepare('SELECT * FROM slack_apps WHERE enabled = 1').all() as unknown as SlackRow[]
  },
  save(db: Db, botId: string, f: {
    bot_token: string; app_token: string; team_id: string; team_name: string; team_url: string
    bot_user_id: string; bot_user_name: string; app_id: string | null
  }): void {
    const now = Date.now()
    db.prepare(
      `INSERT INTO slack_apps (bot_id, bot_token_enc, app_token_enc, team_id, team_name, team_url, bot_user_id, bot_user_name, app_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(bot_id) DO UPDATE SET bot_token_enc = excluded.bot_token_enc, app_token_enc = excluded.app_token_enc,
         team_id = excluded.team_id, team_name = excluded.team_name, team_url = excluded.team_url,
         bot_user_id = excluded.bot_user_id, bot_user_name = excluded.bot_user_name, app_id = excluded.app_id,
         enabled = 1, updated_at = excluded.updated_at`,
    ).run(botId, encrypt(f.bot_token), encrypt(f.app_token), f.team_id, f.team_name, f.team_url,
      f.bot_user_id, f.bot_user_name, f.app_id, now, now)
  },
  setAccess(db: Db, botId: string, allowAll: boolean, users: SlackUser[]): void {
    db.prepare('UPDATE slack_apps SET allow_all = ?, allowed_users_json = ?, updated_at = ? WHERE bot_id = ?')
      .run(allowAll ? 1 : 0, JSON.stringify(users), Date.now(), botId)
  },
  setEnabled(db: Db, botId: string, on: boolean): void {
    db.prepare('UPDATE slack_apps SET enabled = ?, updated_at = ? WHERE bot_id = ?').run(on ? 1 : 0, Date.now(), botId)
  },
  remove(db: Db, botId: string): void {
    db.prepare('DELETE FROM slack_apps WHERE bot_id = ?').run(botId)
  },
  users(r: SlackRow): SlackUser[] { return JSON.parse(r.allowed_users_json || '[]') as SlackUser[] },
  tokens(r: SlackRow): { bot: string; app: string } { return { bot: decrypt(r.bot_token_enc), app: decrypt(r.app_token_enc) } },

  threadFor(db: Db, botId: string, channel: string, key: string): string | undefined {
    const r = db.prepare('SELECT thread_id, updated_at FROM slack_threads WHERE bot_id = ? AND channel = ? AND thread_key = ?')
      .get(botId, channel, key) as { thread_id: string; updated_at: number } | undefined
    if (!r || !db.prepare('SELECT 1 FROM threads WHERE id = ?').get(r.thread_id)) return undefined
    // A DM's top level is one running conversation, but a new day is a new topic.
    if (key === 'dm' && Date.now() - r.updated_at > DM_FRESH_MS) return undefined
    return r.thread_id
  },
  bindThread(db: Db, botId: string, channel: string, key: string, threadId: string): void {
    db.prepare(
      `INSERT INTO slack_threads (bot_id, channel, thread_key, thread_id, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(bot_id, channel, thread_key) DO UPDATE SET thread_id = excluded.thread_id, updated_at = excluded.updated_at`,
    ).run(botId, channel, key, threadId, Date.now())
  },
  newThread(db: Db, botId: string): string {
    const id = `thr_${randomUUID().replaceAll('-', '').slice(0, 16)}`
    db.prepare(`INSERT INTO threads (id, bot_id, kind, title, last_message_at, created_at) VALUES (?, ?, 'slack', '', ?, ?)`)
      .run(id, botId, Date.now(), Date.now())
    return id
  },
}

// ---------------------------------------------------------------- the Web API

/** Overridable so the tests can run against a fake Slack. */
const SLACK_API = process.env.GROKKED_SLACK_API ?? 'https://slack.com/api'

export async function slackApi<T = Record<string, unknown>>(token: string, method: string, body: Record<string, unknown> = {}): Promise<T & { ok: boolean; error?: string }> {
  const res = await fetch(`${SLACK_API}/${method}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  })
  if (res.status === 429) {
    const wait = Number(res.headers.get('retry-after') ?? 1)
    await new Promise((r) => setTimeout(r, Math.min(wait, 30) * 1000))
    return slackApi(token, method, body)
  }
  return (await res.json()) as T & { ok: boolean; error?: string }
}

/** Checks both tokens and says who the bot is in which workspace. */
export async function checkTokens(botToken: string, appToken: string): Promise<
  { ok: true; team_id: string; team_name: string; team_url: string; bot_user_id: string; bot_user_name: string; app_id: string | null }
  | { ok: false; message: string }> {
  if (!/^xoxb-/.test(botToken)) return { ok: false, message: 'The Bot User OAuth Token starts with xoxb-.' }
  if (!/^xapp-/.test(appToken)) return { ok: false, message: 'The App-Level Token starts with xapp-.' }
  const auth = await slackApi<{ team_id: string; team: string; url: string; user_id: string; user: string; bot_id: string }>(botToken, 'auth.test')
    .catch((e) => ({ ok: false, error: (e as Error).message }) as never)
  if (!auth.ok) return { ok: false, message: `Slack didn't accept the bot token (${auth.error}). Install the app to your workspace and copy the Bot User OAuth Token.` }
  const conn = await slackApi(appToken, 'apps.connections.open').catch((e) => ({ ok: false, error: (e as Error).message }) as never)
  if (!conn.ok) {
    return { ok: false, message: conn.error === 'not_allowed_token_type' || conn.error === 'invalid_auth'
      ? "Slack didn't accept the app token. Make an App-Level Token with the connections:write scope (Basic Information → App-Level Tokens)."
      : `Slack didn't accept the app token (${conn.error}). Is Socket Mode on? The manifest turns it on.` }
  }
  const bot = await slackApi<{ bot?: { app_id?: string } }>(botToken, 'bots.info', { bot: auth.bot_id }).catch(() => ({ ok: false }) as never)
  return {
    ok: true, team_id: auth.team_id, team_name: auth.team, team_url: auth.url, bot_user_id: auth.user_id,
    bot_user_name: auth.user, app_id: bot.ok ? bot.bot?.app_id ?? null : null,
  }
}

// ---------------------------------------------------------------- the connection

type Send = (input: { bot_id: string; goal: string; thread_id: string }) =>
  { status: number; body: Record<string, unknown> }

const DONE = new Set(['succeeded', 'failed', 'blocked', 'paused_budget', 'cancelled'])
const MAX_TEXT = 39_000

/** One bot's Socket Mode connection, reconnecting until stopped. */
class SlackConnection {
  status: SlackStatus = { state: 'connecting', since: Date.now() }
  #ws: WebSocket | null = null
  #stopped = false
  #retry = 0
  #seen = new Set<string>()
  #names = new Map<string, string>()
  #lastRefusal = new Map<string, number>()
  #botToken = ''
  #appToken = ''

  private db: Db
  private bus: EventBus
  private botId: string
  private send: Send
  constructor(db: Db, bus: EventBus, botId: string, send: Send) {
    this.db = db; this.bus = bus; this.botId = botId; this.send = send
  }

  start(): void {
    const row = slackStore.get(this.db, this.botId)
    if (!row) return
    const t = slackStore.tokens(row)
    this.#botToken = t.bot; this.#appToken = t.app
    void this.#connect()
  }

  stop(): void {
    this.#stopped = true
    try { this.#ws?.close() } catch { /* already closed */ }
    this.status = { state: 'off', since: Date.now() }
  }

  #set(state: SlackStatus['state'], detail?: string) {
    if (this.status.state !== state || this.status.detail !== detail) this.status = { state, detail, since: Date.now() }
  }

  async #connect(): Promise<void> {
    if (this.#stopped) return
    this.#set('connecting')
    try {
      const r = await slackApi<{ url: string }>(this.#appToken, 'apps.connections.open')
      if (!r.ok) throw new Error(r.error ?? 'apps.connections.open failed')
      const ws = new WebSocket(r.url)
      this.#ws = ws
      ws.onmessage = (m) => { void this.#onFrame(String(m.data)) }
      ws.onclose = () => { if (this.#ws === ws) this.#reconnect('connection closed') }
      ws.onerror = () => { /* onclose follows */ }
    } catch (e) {
      this.#reconnect((e as Error).message)
    }
  }

  #reconnect(why: string): void {
    this.#ws = null
    if (this.#stopped) return
    const auth = /invalid_auth|token_revoked|not_allowed_token_type|account_inactive/.test(why)
    this.#set('error', auth ? `Slack refused the token (${why}). Paste new tokens.` : `Reconnecting (${why})`)
    if (auth) return
    const delay = Math.min(60_000, 1000 * 2 ** this.#retry++)
    setTimeout(() => void this.#connect(), delay).unref?.()
  }

  async #onFrame(raw: string): Promise<void> {
    let f: { type: string; envelope_id?: string; payload?: { event?: SlackEvent; event_id?: string }; reason?: string }
    try { f = JSON.parse(raw) } catch { return }
    // Ack first, always: Slack retries anything not acked within 3 seconds.
    if (f.envelope_id) this.#ws?.send(JSON.stringify({ envelope_id: f.envelope_id }))
    if (f.type === 'hello') { this.#retry = 0; this.#set('connected'); return }
    if (f.type === 'disconnect') { const ws = this.#ws; this.#ws = null; try { ws?.close() } catch { /* */ } void this.#connect(); return }
    if (f.type !== 'events_api' || !f.payload?.event) return
    try { await this.#onEvent(f.payload.event) } catch (e) { log.error({ bot: this.botId, err: (e as Error).message }, 'slack event failed') }
  }

  async #name(user: string): Promise<string> {
    const hit = this.#names.get(user)
    if (hit) return hit
    const r = await slackApi<{ user?: { real_name?: string; name?: string; profile?: { display_name?: string } } }>(this.#botToken, 'users.info', { user })
      .catch(() => ({ ok: false }) as never)
    const name = (r.ok && (r.user?.profile?.display_name || r.user?.real_name || r.user?.name)) || user
    this.#names.set(user, name)
    return name
  }

  async #onEvent(e: SlackEvent): Promise<void> {
    const row = slackStore.get(this.db, this.botId)
    if (!row?.enabled) return
    const channel = e.channel ?? ''
    const isDm = e.channel_type === 'im'
    const key = e.thread_ts ?? (isDm ? 'dm' : e.ts ?? '')
    const known = !!(e.thread_ts && slackStore.threadFor(this.db, this.botId, channel, e.thread_ts))
    if (!isForBot(e, row.bot_user_id, known)) return
    // An @mention arrives twice (app_mention and message.*): once is enough.
    const seenKey = `${channel}:${e.ts}`
    if (this.#seen.has(seenKey)) return
    this.#seen.add(seenKey)
    if (this.#seen.size > 1000) this.#seen = new Set([...this.#seen].slice(-500))

    const user = e.user!
    const replyTs = isDm && !e.thread_ts ? undefined : (e.thread_ts ?? e.ts)
    if (!(await this.#allowed(row, user, channel, replyTs))) return

    const names: Record<string, string> = {}
    for (const m of (e.text ?? '').matchAll(/<@([A-Z0-9]+)/g)) if (m[1] !== row.bot_user_id) names[m[1]!] = await this.#name(m[1]!)
    const text = slackToText(e.text ?? '', names, row.bot_user_id ?? undefined)
    const who = await this.#name(user)
    const where = isDm ? 'a direct message' : `<#${channel}>`

    void this.#api('reactions.add', { channel, timestamp: e.ts, name: 'eyes' })
    const placeholder = await this.#api<{ ts: string }>('chat.postMessage', {
      channel, text: '_On it…_', ...(replyTs ? { thread_ts: replyTs } : {}),
    })

    let threadId = slackStore.threadFor(this.db, this.botId, channel, key)
    if (!threadId) threadId = slackStore.newThread(this.db, this.botId)
    slackStore.bindThread(this.db, this.botId, channel, key, threadId)
    // A reply in the thread under its first answer continues the same conversation.
    if (!e.thread_ts && !isDm && e.ts) slackStore.bindThread(this.db, this.botId, channel, e.ts, threadId)

    const goal = `[Slack: ${who} in ${isDm ? where : `#${await this.#channelName(channel)}`}]\n${text}`
    const out = this.send({ bot_id: this.botId, goal, thread_id: threadId })
    const run = out.body.run as { id: string } | undefined
    if (!run) {
      await this.#finish(channel, e.ts!, placeholder.ts,
        out.status === 409 ? "I'm busy with another task right now. Try me again in a minute." : `I couldn't start on that: ${String(out.body.message ?? out.body.error)}`,
        'hourglass_flowing_sand')
      return
    }
    await this.#follow(run.id, channel, e.ts!, placeholder.ok ? placeholder.ts : undefined, replyTs)
  }

  #channels = new Map<string, string>()
  async #channelName(id: string): Promise<string> {
    if (this.#channels.has(id)) return this.#channels.get(id)!
    const r = await this.#api<{ channel?: { name?: string } }>('conversations.info', { channel: id })
    const n = (r.ok && r.channel?.name) || id
    this.#channels.set(id, n)
    return n
  }

  /** On the list, or the first person ever (who is then added). Others get one polite no per hour. */
  async #allowed(row: SlackRow, user: string, channel: string, threadTs?: string): Promise<boolean> {
    if (row.allow_all) return true
    const users = slackStore.users(row)
    if (users.some((u) => u.id === user)) return true
    if (!users.length) {
      slackStore.setAccess(this.db, this.botId, false, [{ id: user, name: await this.#name(user) }])
      log.info({ bot: this.botId, user }, 'slack: first person to message the bot is now on its list')
      return true
    }
    const k = `${channel}:${user}`
    if (Date.now() - (this.#lastRefusal.get(k) ?? 0) > 3600_000) {
      this.#lastRefusal.set(k, Date.now())
      const owner = users[0]!
      await this.#api('chat.postEphemeral', {
        channel, user, ...(threadTs ? { thread_ts: threadTs } : {}),
        text: `I only take requests from the people on my list. Ask <@${owner.id}> to add you in my Slack tab in Grokked Bot.`,
      })
    }
    return false
  }

  /** Edits the placeholder as the bot works, then puts the answer (or its question) there. */
  async #follow(runId: string, channel: string, msgTs: string, placeholderTs: string | undefined, threadTs?: string): Promise<void> {
    let lastEdit = 0
    let pending: string | null = null
    const edit = (text: string) => {
      if (!placeholderTs) return
      pending = text
      const now = Date.now()
      if (now - lastEdit < 2500) return
      lastEdit = now
      const t = pending; pending = null
      void this.#api('chat.update', { channel, ts: placeholderTs, text: t })
    }
    const unsubscribe = this.bus.subscribe((f) => {
      if (f.topic !== `run:${runId}` || f.type !== 'run.step') return
      const d = f.data as { kind?: string; step_no?: number; tool_name?: string; summary?: string; text?: string }
      if (d.kind === 'tool_call' && d.tool_name && !['finish', 'ask_human', 'give_up'].includes(d.tool_name)) {
        edit(`_Working… step ${d.step_no ?? ''}: ${(d.summary || d.tool_name).replace(/[_*`]/g, '').slice(0, 140)}_`)
      }
    })
    try {
      for (;;) {
        await new Promise((r) => setTimeout(r, 1500))
        const r = this.db.prepare('SELECT state, state_reason, outcome_summary FROM runs WHERE id = ?').get(runId) as
          { state: string; state_reason: string | null; outcome_summary: string | null } | undefined
        if (!r) return
        if (!DONE.has(r.state)) continue
        if (r.state === 'succeeded') return void await this.#finish(channel, msgTs, placeholderTs, r.outcome_summary || 'Done.', 'white_check_mark', threadTs)
        if (r.state === 'blocked' && r.state_reason === 'ask_human') {
          return void await this.#finish(channel, msgTs, placeholderTs, `${r.outcome_summary ?? 'I need your input.'}\n\n_Reply in this thread and I'll carry on._`, 'raised_hand', threadTs)
        }
        const why = r.state === 'paused_budget' ? 'I hit my budget for this task. Raise it in the app to let me continue.'
          : r.state === 'cancelled' ? 'Stopped.'
            : `That didn't work out${r.outcome_summary ? `: ${r.outcome_summary}` : r.state_reason ? ` (${r.state_reason})` : '.'}`
        return void await this.#finish(channel, msgTs, placeholderTs, why, 'x', threadTs)
      }
    } finally {
      unsubscribe()
    }
  }

  async #finish(channel: string, msgTs: string, placeholderTs: string | undefined, text: string, emoji: string, threadTs?: string): Promise<void> {
    const body = toMrkdwn(text).slice(0, MAX_TEXT)
    const updated = placeholderTs ? await this.#api('chat.update', { channel, ts: placeholderTs, text: body }) : { ok: false }
    if (!updated.ok) await this.#api('chat.postMessage', { channel, text: body, ...(threadTs ? { thread_ts: threadTs } : {}) })
    await this.#api('reactions.remove', { channel, timestamp: msgTs, name: 'eyes' })
    await this.#api('reactions.add', { channel, timestamp: msgTs, name: emoji })
  }

  #api<T = Record<string, unknown>>(method: string, body: Record<string, unknown>) {
    return slackApi<T>(this.#botToken, method, body).catch((e) => {
      log.warn({ bot: this.botId, method, err: (e as Error).message }, 'slack api call failed')
      return { ok: false, error: (e as Error).message } as T & { ok: boolean; error?: string }
    })
  }
}

// ---------------------------------------------------------------- all bots

const conns = new Map<string, SlackConnection>()
let ctx: { db: Db; bus: EventBus; send: Send } | null = null

export const slack = {
  /** On daemon start: connect every bot that has Slack on. */
  startAll(db: Db, bus: EventBus, send: Send): void {
    ctx = { db, bus, send }
    for (const r of slackStore.all(db)) slack.restart(r.bot_id)
  },
  /** After its settings change: drop the old connection, open a new one if it's on. */
  restart(botId: string): void {
    conns.get(botId)?.stop()
    conns.delete(botId)
    if (!ctx) return
    const row = slackStore.get(ctx.db, botId)
    if (!row?.enabled) return
    const c = new SlackConnection(ctx.db, ctx.bus, botId, ctx.send)
    conns.set(botId, c)
    c.start()
  },
  status(botId: string): SlackStatus {
    return conns.get(botId)?.status ?? { state: 'off', since: Date.now() }
  },
  stopAll(): void {
    for (const c of conns.values()) c.stop()
    conns.clear()
  },
}
