/**
 * Slack bots against a fake Slack: the Web API and a Socket Mode WebSocket on
 * localhost. A DM goes in; the bot acks, reacts 👀, posts "On it…", edits it as
 * steps happen, and replaces it with the answer. Plus the pure pieces: the
 * manifest, Slack text in, mrkdwn out, and which messages are for the bot.
 */
import { strict as assert } from 'node:assert'
import { mkdtempSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocketServer, type WebSocket } from 'ws'

const dir = mkdtempSync(join(tmpdir(), 'grokked-slack-'))
process.env.GROKKED_CONFIG_DIR = join(dir, 'config')
process.env.GROKKED_DATA_DIR = join(dir, 'data')
process.env.GROKKED_RUNTIME_DIR = join(dir, 'run')

// ---- the fake Slack
const calls: Array<{ method: string; body: any }> = []
let socket: WebSocket | null = null
const acks: string[] = []
const server = createServer(async (req, res) => {
  const method = req.url!.split('/').pop()!
  let raw = ''
  for await (const ch of req) raw += ch
  const body = raw ? JSON.parse(raw) : {}
  const auth = req.headers.authorization ?? ''
  calls.push({ method, body })
  const reply = (o: object) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, ...o })) }
  if (method === 'auth.test') return auth === 'Bearer xoxb-good' ? reply({ team_id: 'T1', team: 'Acme', url: 'https://acme.slack.com/', user_id: 'UBOT', user: 'ops-bot', bot_id: 'B1' }) : reply({ ok: false, error: 'invalid_auth' })
  if (method === 'apps.connections.open') return auth === 'Bearer xapp-good' ? reply({ url: `ws://127.0.0.1:${port}/socket` }) : reply({ ok: false, error: 'invalid_auth' })
  if (method === 'bots.info') return reply({ bot: { app_id: 'A1' } })
  if (method === 'users.info') return reply({ user: { real_name: body.user === 'UALF' ? 'Alfred' : 'Mallory' } })
  if (method === 'chat.postMessage') return reply({ ts: `9${calls.length}.0001` })
  return reply({})
})
const wss = new WebSocketServer({ noServer: true })
server.on('upgrade', (req, sock, head) => wss.handleUpgrade(req, sock, head, (ws) => {
  socket = ws
  ws.on('message', (m) => acks.push(JSON.parse(String(m)).envelope_id))
  ws.send(JSON.stringify({ type: 'hello' }))
}))
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
const port = (server.address() as { port: number }).port
process.env.GROKKED_SLACK_API = `http://127.0.0.1:${port}/api`

const { ensureDirs } = await import('../src/config.ts')
ensureDirs()
const { openDb } = await import('../src/db/index.ts')
const { EventBus } = await import('../src/events.ts')
const S = await import('../src/slack.ts')
const { Hono } = await import('hono')
const { mountSlack } = await import('../src/http/slack.ts')

// ---- pure pieces
const m = S.slackManifest({ name: 'Ops Bot', persona_md: 'Keeps the servers healthy.\nMore.' }, '#223344')
assert.match(m, /name: "Ops Bot"/)
assert.match(m, /description: "Keeps the servers healthy."/)
assert.match(m, /display_name: "ops-bot"/)
assert.match(m, /socket_mode_enabled: true/)
assert.match(S.slackManifest({ name: 'X', description: 'Watches the servers.', persona_md: 'You are X.' }), /description: "Watches the servers."/)
assert.match(m, /- message\.im\n/)
assert.match(m, /messages_tab_read_only_enabled: false/)
assert.ok(!/request_url/.test(m), 'Socket Mode: no public URL in the manifest')
console.log('  ok  manifest: name, description, Socket Mode, DMs, no request URL')

assert.equal(S.slackToText('<@UBOT> check <#C1|ops> for <@U2> &amp; see <https://x.io|the docs>', { U2: 'Sam' }, 'UBOT'),
  'check #ops for @Sam & see the docs (https://x.io)')
assert.equal(S.toMrkdwn('## Done\n**Disk** is [fine](https://a.b) ~~bad~~\n- one\n```ts\nconst **x** = 1\n```'),
  '*Done*\n*Disk* is <https://a.b|fine> ~bad~\n• one\n```\nconst **x** = 1\n```')
console.log('  ok  Slack text in, mrkdwn out (code left alone)')

const ev = (o: Partial<import('../src/slack.ts').SlackEvent>) => ({ type: 'message', user: 'UALF', channel: 'C1', ts: '1.1', text: 'hi', ...o })
assert.ok(S.isForBot(ev({ channel_type: 'im' }), 'UBOT', false))
assert.ok(S.isForBot(ev({ type: 'app_mention', text: '<@UBOT> hi' }), 'UBOT', false))
assert.ok(!S.isForBot(ev({ channel_type: 'channel' }), 'UBOT', false), 'channel chatter is not for it')
assert.ok(S.isForBot(ev({ channel_type: 'channel', thread_ts: '0.9' }), 'UBOT', true), 'a reply in its thread is')
assert.ok(!S.isForBot(ev({ channel_type: 'im', user: 'UBOT' }), 'UBOT', false), 'not its own posts')
assert.ok(!S.isForBot(ev({ channel_type: 'im', bot_id: 'B9' }), 'UBOT', false), 'not other bots')
assert.ok(!S.isForBot(ev({ channel_type: 'im', subtype: 'message_changed' }), 'UBOT', false), 'not edits')
assert.ok(!S.isForBot(ev({ type: 'app_mention', text: '<@UBOT>' }), 'UBOT', false), 'not an empty mention')
console.log('  ok  answers DMs, mentions and its threads; ignores chatter, itself, bots, edits')

// ---- connect over the API
const db = openDb()
const bus = new EventBus(db)
db.prepare(`INSERT INTO bots (id, name, persona_md, autonomy, status, created_at, updated_at) VALUES ('b1', 'Ops Bot', '', 'supervised', 'active', 0, 0)`).run()
const app = new Hono()
mountSlack(app, db)
const call = async (method: string, path: string, body?: unknown) => {
  const r = await app.request(path, { method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
  return { status: r.status, json: await r.json() as any, text: '' }
}

// The bot "runs": a run row that takes a step, then succeeds.
const goals: string[] = []
let n = 0
const send = (input: { bot_id: string; goal: string; thread_id: string }) => {
  goals.push(input.goal)
  const id = `run_${++n}`
  db.prepare(`INSERT INTO runs (id, bot_id, thread_id, trigger_kind, goal, state, created_at) VALUES (?, ?, ?, 'user', ?, 'running', ?)`)
    .run(id, input.bot_id, input.thread_id, input.goal, Date.now())
  setTimeout(() => bus.emit({ topic: `run:${id}`, type: 'run.step', run_id: id, data: { kind: 'tool_call', step_no: 1, tool_name: 'run_bash', summary: "ssh web 'df -h'" } }), 300)
  setTimeout(() => db.prepare("UPDATE runs SET state = 'succeeded', outcome_summary = ? WHERE id = ?").run('**134 GB** free on web.', id), 1800)
  return { status: 201, body: { run: { id } } }
}
S.slack.startAll(db, bus, send)

assert.equal((await call('PUT', '/v1/bots/b1/slack', { bot_token: 'xoxb-bad', app_token: 'xapp-good' })).status, 400)
assert.equal((await call('PUT', '/v1/bots/b1/slack', { bot_token: 'nope', app_token: 'xapp-good' })).json.message, 'The Bot User OAuth Token starts with xoxb-.')
const connected = await call('PUT', '/v1/bots/b1/slack', { bot_token: 'xoxb-good', app_token: 'xapp-good' })
assert.equal(connected.status, 200)
assert.equal(connected.json.team_name, 'Acme')
assert.equal(connected.json.status.state, 'connected')
assert.equal(connected.json.app_id, 'A1')
assert.ok(!JSON.stringify(connected.json).includes('xoxb-good'), 'tokens never come back out')
const stored = db.prepare("SELECT bot_token_enc FROM slack_apps WHERE bot_id='b1'").get() as { bot_token_enc: string }
assert.ok(!stored.bot_token_enc.includes('xoxb'), 'stored encrypted')
console.log('  ok  bad tokens refused with a plain reason; good ones saved encrypted and connected')

// ---- a DM comes in
const wait = async (f: () => boolean, ms = 6000) => { const end = Date.now() + ms; while (!f()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 50)) } }
const deliver = (event: object, id: string) => socket!.send(JSON.stringify({ type: 'events_api', envelope_id: id, payload: { event_id: id, event } }))
calls.length = 0
deliver({ type: 'message', channel_type: 'im', user: 'UALF', channel: 'D1', ts: '100.1', text: 'How much disk is free on web?' }, 'env1')
await wait(() => acks.includes('env1'))
await wait(() => calls.some((c) => c.method === 'reactions.add' && c.body.name === 'white_check_mark'))
const seq = calls.map((c) => c.method === 'reactions.add' || c.method === 'reactions.remove' ? `${c.method}:${c.body.name}` : c.method)
assert.ok(seq.indexOf('reactions.add:eyes') < seq.indexOf('chat.postMessage'), '👀 first')
const post = calls.find((c) => c.method === 'chat.postMessage')!
assert.equal(post.body.text, '_On it…_')
assert.equal(post.body.thread_ts, undefined, 'a DM is answered in the DM, not a thread')
const updates = calls.filter((c) => c.method === 'chat.update').map((c) => c.body.text)
assert.ok(updates.some((t) => t.startsWith('_Working… step 1')), 'shows what it is doing')
assert.equal(updates.at(-1), '*134 GB* free on web.', 'the answer replaces the placeholder, in mrkdwn')
assert.ok(seq.includes('reactions.remove:eyes'))
assert.match(goals[0]!, /^\[Slack: Alfred in a direct message\]\nHow much disk is free on web\?$/)
const owner = (await call('GET', '/v1/bots/b1/slack')).json.allowed_users
assert.deepEqual(owner, [{ id: 'UALF', name: 'Alfred' }], 'the first person to message it is on its list')
const thr = db.prepare("SELECT t.kind FROM slack_threads s JOIN threads t ON t.id = s.thread_id WHERE s.channel = 'D1'").get() as { kind: string }
assert.equal(thr.kind, 'slack')
console.log('  ok  DM: ack, 👀, "On it…", live step, answer in place, ✅; sender becomes the owner')

// ---- an @mention in a channel arrives twice (app_mention + message.channels); answered once, in a thread
calls.length = 0
const mention = { user: 'UALF', channel: 'C1', ts: '200.1', text: '<@UBOT> and on db?', channel_type: 'channel' }
deliver({ type: 'app_mention', ...mention }, 'env2')
deliver({ type: 'message', ...mention }, 'env3')
await wait(() => calls.some((c) => c.method === 'reactions.add' && c.body.name === 'white_check_mark'))
const posts = calls.filter((c) => c.method === 'chat.postMessage')
assert.equal(posts.length, 1, 'answered once')
assert.equal(posts[0]!.body.thread_ts, '200.1', 'in a thread under the mention')
assert.match(goals[1]!, /\nand on db\?$/)
// a reply in that thread, no @, continues the same conversation
deliver({ type: 'message', user: 'UALF', channel: 'C1', ts: '201.1', thread_ts: '200.1', text: 'thanks, and memory?', channel_type: 'channel' }, 'env4')
await wait(() => goals.length === 3)
const [t2, t3] = [...db.prepare("SELECT thread_id FROM runs WHERE id IN ('run_2','run_3') ORDER BY id").all()] as Array<{ thread_id: string }>
assert.equal(t2!.thread_id, t3!.thread_id)
console.log('  ok  @mention answered once in a thread; a reply there needs no @ and keeps the conversation')

// ---- someone not on the list
calls.length = 0
deliver({ type: 'message', channel_type: 'im', user: 'UMAL', channel: 'D2', ts: '300.1', text: 'delete everything' }, 'env5')
await wait(() => calls.some((c) => c.method === 'chat.postEphemeral'))
assert.match(calls.find((c) => c.method === 'chat.postEphemeral')!.body.text, /Ask <@UALF> to add you/)
assert.equal(goals.length, 3, 'no run for a stranger')
console.log('  ok  people not on the list are turned away politely, no run')

await call('PATCH', '/v1/bots/b1/slack', { allow_all: true })
deliver({ type: 'message', channel_type: 'im', user: 'UMAL', channel: 'D2', ts: '301.1', text: 'hello' }, 'env6')
await wait(() => goals.length === 4)
console.log('  ok  "Anyone in the workspace" lets them in')

const off = (await call('DELETE', '/v1/bots/b1/slack')).json
assert.equal(off.configured, false)
assert.equal(off.status.state, 'off')
S.slack.stopAll()
server.close(); wss.close()
console.log('\nall passed')
process.exit(0)
