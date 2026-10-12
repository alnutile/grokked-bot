/** Pinned responses: save, no duplicates, list newest first, unpin. */
import { strict as assert } from 'node:assert'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'grokked-pins-'))
process.env.GROKKED_CONFIG_DIR = join(dir, 'config')
process.env.GROKKED_DATA_DIR = join(dir, 'data')
process.env.GROKKED_RUNTIME_DIR = join(dir, 'run')

const { ensureDirs } = await import('../src/config.ts')
ensureDirs()
const { openDb } = await import('../src/db/index.ts')
const { Hono } = await import('hono')
const { mountPins } = await import('../src/http/pins.ts')

const db = openDb()
db.prepare(`INSERT INTO bots (id, name, persona_md, autonomy, status, created_at, updated_at) VALUES ('b1', 'Bot', '', 'supervised', 'active', 0, 0)`).run()
db.prepare(`INSERT INTO threads (id, bot_id, kind, title, created_at) VALUES ('t1', 'b1', 'chat', 'Top spenders', 0)`).run()
const app = new Hono()
mountPins(app, db)
const call = (method: string, path: string, body?: unknown) =>
  app.request(path, { method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })

const a = await (await call('POST', '/v1/pins', { bot_id: 'b1', thread_id: 't1', text: 'Ted Cruz spent the most.' })).json() as any
assert.match(a.pin.id, /^pin_/)
const again = await (await call('POST', '/v1/pins', { bot_id: 'b1', thread_id: 't1', text: 'Ted Cruz spent the most.' })).json() as any
assert.equal(again.pin.id, a.pin.id, 'pinning the same response twice keeps one pin')
await new Promise((r) => setTimeout(r, 5))
await call('POST', '/v1/pins', { bot_id: 'b1', thread_id: 't1', text: 'A second answer.' })
assert.equal((await call('POST', '/v1/pins', { bot_id: 'b1', text: '  ' })).status, 400)
assert.equal((await call('POST', '/v1/pins', { bot_id: 'nope', text: 'x' })).status, 404)
console.log('  ok  pins save once, and refuse empty text or unknown bots')

const list = (await (await call('GET', '/v1/pins')).json() as any).pins
assert.deepEqual(list.map((p: any) => p.text), ['A second answer.', 'Ted Cruz spent the most.'])
assert.equal(list[0].thread_title, 'Top spenders')
assert.equal((await (await call('GET', '/v1/pins?thread_id=t1')).json() as any).pins.length, 2)
console.log('  ok  newest first, with the conversation title to link back')

await call('DELETE', `/v1/pins/${a.pin.id}`)
assert.equal((await (await call('GET', '/v1/pins')).json() as any).pins.length, 1)
console.log('  ok  unpin')
console.log('\nall passed')
