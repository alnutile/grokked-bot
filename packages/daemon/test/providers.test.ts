import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'grokked-providers-'))
process.env.GROKKED_CONFIG_DIR = join(dir, 'config')
process.env.GROKKED_DATA_DIR = join(dir, 'data')
process.env.GROKKED_RUNTIME_DIR = join(dir, 'run')
const { ensureDirs, saveConfig, loadConfig, setProviderKey, modelTarget } = await import('../src/config.ts')
ensureDirs()
const { chat } = await import('../src/model/openrouter.ts')
const { openDb } = await import('../src/db/index.ts')
const { Hono } = await import('hono')
const { mountSettings } = await import('../src/http/settings.ts')
const { executeStep, createRun } = await import('../src/agent/loop.ts')
const { autoTitle } = await import('../src/agent/titles.ts')
const { EventBus } = await import('../src/events.ts')
const db = openDb(':memory:')
const app = new Hono()
mountSettings(app, db)
const patch = (body: unknown) => app.request('/v1/settings', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
assert.equal((await patch({ local_url: 'file:///etc/passwd' })).status, 400)
assert.equal((await patch({ local_url: 'http://localhost:1234/v1', models: { worker: 'local::text', classifier: 'local::title', vision: '' } })).status, 200)
assert.equal((await patch({ models: { worker: '' } })).status, 400)
setProviderKey('openai', 'test-secret')
assert.ok(!JSON.stringify(await (await app.request('/v1/settings')).json()).includes('test-secret'))
assert.ok(readFileSync(join(dir, 'config/env'), 'utf8').includes('OPENAI_API_KEY='))
assert.equal(modelTarget('anthropic/claude').provider, 'openrouter')
let sent: any
let sentUrl = ''
let sentHeaders: any
let response: any = { id: 'fake', model: 'text', choices: [{ message: { content: 'Title Here' }, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 4 } } }
const originalFetch = globalThis.fetch
globalThis.fetch = (async (url, options) => {
  sentUrl = String(url); sent = JSON.parse(String(options?.body ?? '{}')); sentHeaders = options?.headers
  return Response.json(response)
}) as typeof fetch
try {
  const result = await chat({ model: 'local::text', messages: [{ role: 'user', content: 'hello' }] })
  assert.equal(sentUrl, 'http://localhost:1234/v1/chat/completions')
  assert.equal(sent.model, 'text')
  assert.equal(sent.usage, undefined)
  assert.equal(sentHeaders.authorization, undefined)
  assert.equal(result.cost_known, false)
  assert.equal(result.usage_known, true)
  setProviderKey('openrouter', 'router-test')
  await chat({ model: 'anthropic/test', messages: [{ role: 'system', content: 'cache me' }] })
  assert.equal(sent.model, 'anthropic/test')
  assert.deepEqual(sent.usage, { include: true })
  assert.ok(sent.messages[0].content[0].cache_control)
  assert.equal(sentHeaders.authorization, 'Bearer router-test')
  await chat({ model: 'openai::gpt-test', messages: [] })
  assert.equal(sentHeaders.authorization, 'Bearer test-secret')
  assert.equal(sent.temperature, undefined)
  assert.equal(sent.max_completion_tokens, 4096)
  db.prepare(`INSERT INTO bots (id, name, created_at, updated_at) VALUES ('b', 'Local Bot', 0, 0)`).run()
  const bus = new EventBus(db)
  const runId = createRun(db, { bot_id: 'b', goal: 'hello' })
  db.prepare("UPDATE runs SET state = 'running' WHERE id = ?").run(runId)
  const runtime = { isHumanInControl: async () => false } as any
  await executeStep(db, bus, runtime, runId)
  assert.equal(sent.model, 'text')
  const run = db.prepare('SELECT thread_id FROM runs WHERE id = ?').get(runId) as any
  db.prepare(`INSERT INTO messages (id, thread_id, seq, role, content_json, run_id, created_at) VALUES ('img', ?, 999, 'user', ?, ?, 0)`)
    .run(run.thread_id, JSON.stringify([{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,eA==' } }]), runId)
  saveConfig({ models: { vision: 'local::eyes' } })
  await executeStep(db, bus, runtime, runId)
  assert.equal(sent.model, 'eyes', 'images route to configured vision model with tools')
  assert.ok(sent.tools.length)
  const roles = db.prepare('SELECT role FROM llm_calls ORDER BY created_at').all() as any[]
  assert.deepEqual(roles.map(r => r.role), ['worker', 'vision'])
  autoTitle(db, bus, run.thread_id, 'b', 'hello')
  for (let i = 0; i < 20; i++) {
    if ((db.prepare("SELECT COUNT(*) AS n FROM llm_calls WHERE role = 'classifier'").get() as any).n) break
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  const usage = await (await app.request('/v1/usage')).json() as any
  assert.equal(usage.rows.reduce((n: number, r: any) => n + r.calls, 0), 3)
  assert.ok(usage.rows.every((r: any) => r.bot_id === 'b' && r.unknown_cost_calls === 1 && r.input_tokens === 12 && r.cached_tokens === 4))
  response = { ...response, usage: { prompt_tokens: 1, completion_tokens: 2, cost: 0, cost_details: { upstream_inference_cost: 0.5 } } }
  const billed = await chat({ model: 'local::text', messages: [] })
  assert.equal(billed.cost_usd, 0.5)
  assert.equal(billed.cost_known, true)
  response = { choices: [{ message: {} }] }
  const missing = await chat({ model: 'local::text', messages: [] })
  assert.equal(missing.usage.prompt_tokens, 0)
  assert.equal(missing.usage_known, false)
  assert.equal(loadConfig().models.vision, 'local::eyes')
} finally { globalThis.fetch = originalFetch; db.close() }
console.log('providers, vision routing, title accounting, usage and settings passed')
