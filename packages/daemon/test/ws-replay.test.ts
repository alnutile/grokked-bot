/**
 * M0 acceptance: the WS is a cache-invalidation channel and `events` is the
 * source of truth. A client that disconnects, misses frames, and reconnects with
 * `since=` must receive exactly what it missed — and be told when it can't.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serve } from '@hono/node-server'
import WebSocket from 'ws'
import { openDb } from '../src/db/index.ts'
import { EventBus } from '../src/events.ts'
import { createApp } from '../src/http/app.ts'
import { attachWs } from '../src/ws/hub.ts'

const dir = mkdtempSync(join(tmpdir(), 'grokked-test-'))
const db = openDb(join(dir, 'test.db'))
const bus = new EventBus(db)
const TOKEN = 'test-token-abcdefghijklmnop'
const app = createApp({ db, bus, token: TOKEN, startedAt: Date.now() })

const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 })
attachWs(server as unknown as import('node:http').Server, bus, TOKEN)
await new Promise((r) => setTimeout(r, 150))
const port = (server.address() as { port: number }).port

type Frame = { seq: number; type: string; topic: string; data: unknown }

function connect(since = 0): Promise<{ ws: WebSocket; frames: Frame[]; next: () => Promise<Frame> }> {
  const url = `ws://127.0.0.1:${port}/v1/stream?token=${TOKEN}${since ? `&since=${since}` : ''}`
  const ws = new WebSocket(url)
  const frames: Frame[] = []
  const waiters: Array<(f: Frame) => void> = []
  ws.on('message', (raw) => {
    const f = JSON.parse(raw.toString()) as Frame
    frames.push(f)
    waiters.shift()?.(f)
  })
  const next = () =>
    new Promise<Frame>((resolve, reject) => {
      const pending = frames.find((f) => !(f as Frame & { _seen?: boolean })._seen)
      if (pending) { (pending as Frame & { _seen?: boolean })._seen = true; return resolve(pending) }
      waiters.push((f) => { (f as Frame & { _seen?: boolean })._seen = true; resolve(f) })
      setTimeout(() => reject(new Error('timeout waiting for frame')), 3000)
    })
  return new Promise((resolve, reject) => {
    ws.on('open', () => resolve({ ws, frames, next }))
    ws.on('error', (e) => reject(e))
  })
}

let failures = 0
const check = (name: string, fn: () => void | Promise<void>) =>
  Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ok  ${name}`))
    .catch((e) => { failures++; console.log(`FAIL  ${name}\n      ${(e as Error).message}`) })

// --- 1. auth ---------------------------------------------------------------
await check('rejects a bad WS token', async () => {
  const bad = new WebSocket(`ws://127.0.0.1:${port}/v1/stream?token=wrong`)
  const err = await new Promise<string>((resolve) => {
    bad.on('error', (e) => resolve(e.message))
    bad.on('open', () => resolve('UNEXPECTEDLY OPENED'))
  })
  assert.match(err, /401/, `expected 401, got: ${err}`)
})

// --- 2. hello + live delivery ---------------------------------------------
const a = await connect()
await check('sends hello on connect', async () => {
  const hello = await a.next()
  assert.equal(hello.type, 'hello')
  assert.equal((hello.data as { dropped: boolean }).dropped, false)
})

await check('delivers live frames only for subscribed topics', async () => {
  a.ws.send(JSON.stringify({ type: 'subscribe', topics: ['run:r1'] }))
  await new Promise((r) => setTimeout(r, 100))
  bus.emit({ topic: 'run:r1', type: 'run.step', data: { step_no: 1 } })
  bus.emit({ topic: 'run:r2', type: 'run.step', data: { step_no: 99 } }) // not subscribed
  const f = await a.next()
  assert.equal(f.topic, 'run:r1')
  assert.equal((f.data as { step_no: number }).step_no, 1)
  await new Promise((r) => setTimeout(r, 150))
  assert.ok(!a.frames.some((x) => x.topic === 'run:r2'), 'leaked an unsubscribed topic')
})

// --- 3. the actual point: replay across a disconnect -----------------------
const lastSeen = bus.serverSeq()
a.ws.close()
await new Promise((r) => setTimeout(r, 100))

bus.emit({ topic: 'run:r1', type: 'run.step', data: { step_no: 2 } })
bus.emit({ topic: 'run:r1', type: 'run.step', data: { step_no: 3 } })
bus.emit({ topic: 'other', type: 'noise', data: {} })

await check('replays exactly the frames missed while disconnected', async () => {
  const b = await connect(lastSeen)
  const hello = await b.next()
  assert.equal(hello.type, 'hello')
  assert.equal((hello.data as { dropped: boolean }).dropped, false)

  b.ws.send(JSON.stringify({ type: 'subscribe', topics: ['run:r1'] }))
  const f1 = await b.next()
  const f2 = await b.next()
  assert.deepEqual(
    [f1, f2].map((f) => (f.data as { step_no: number }).step_no),
    [2, 3],
    'replayed the wrong frames',
  )
  await new Promise((r) => setTimeout(r, 150))
  assert.ok(!b.frames.some((x) => x.topic === 'other'), 'replayed an unsubscribed topic')
  b.ws.close()
})

// --- 4. retention gap must be reported, never silently swallowed -----------
await check('reports dropped=true when since predates retention', async () => {
  db.exec('DELETE FROM events WHERE seq <= 2')
  const c = await connect(1)
  const hello = await c.next()
  assert.equal((hello.data as { dropped: boolean }).dropped, true, 'gap not reported')
  c.ws.close()
})

// --- 5. ping/pong ----------------------------------------------------------
await check('answers ping with pong', async () => {
  const d = await connect()
  await d.next() // hello
  d.ws.send(JSON.stringify({ type: 'ping' }))
  assert.equal((await d.next()).type, 'pong')
  d.ws.close()
})

server.close()
db.close()
rmSync(dir, { recursive: true, force: true })
console.log(failures === 0 ? '\nall passed' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
