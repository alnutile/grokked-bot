/** How much a bot may do and read: model-sized limits, per-bot overrides, clipping. */
import { strict as assert } from 'node:assert'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'grokked-limits-'))
process.env.XDG_CONFIG_HOME = dir
process.env.XDG_DATA_HOME = dir
process.env.GROKKED_DB = join(dir, 'test.db')

const { ensureDirs, loadConfig, CONFIG_DIR } = await import('../src/config.ts')
ensureDirs()
const { openDb } = await import('../src/db/index.ts')
const { DEFAULT_LIMITS, limitsFor } = await import('../src/model/catalog.ts')
const { clip, createRun } = await import('../src/agent/loop.ts')

const model = (context_length: number, max_completion_tokens: number) =>
  ({ id: 'x', name: 'x', context_length, max_completion_tokens, prompt_per_m: 1, completion_per_m: 1 })
assert.deepEqual(limitsFor(undefined), DEFAULT_LIMITS)
assert.equal(limitsFor(model(200_000, 64_000)).maxTokens, 16_000, 'replies capped so credit holds stay small')
assert.equal(limitsFor(model(200_000, 8_192)).maxTokens, 8_192)
assert.equal(limitsFor(model(200_000, 0)).maxTokens, DEFAULT_LIMITS.maxTokens)
assert.equal(limitsFor(model(200_000, 8_192)).toolResultChars, 28_000)
assert.equal(limitsFor(model(1_000_000, 8_192)).toolResultChars, 60_000)
assert.equal(limitsFor(model(8_000, 8_192)).toolResultChars, 4_000)
console.log('  ok  limits follow what OpenRouter says the model takes')

const out = 'START ' + 'x'.repeat(10_000) + ' FAILED: test_add'
const c = clip(out, 1000, 0.6)
assert.ok(c.startsWith('START') && c.endsWith('FAILED: test_add') && c.includes('characters cut'))
assert.equal(clip('short', 1000, 0.6), 'short')
assert.ok(!clip(out, 1000, 1).includes('FAILED'))
console.log('  ok  long output keeps both ends, so the error at the bottom survives')

writeFileSync(join(CONFIG_DIR, 'config.json'), JSON.stringify({ defaults: { max_steps: 40, max_wall_s: 3600, max_usd: 3 } }))
assert.equal(loadConfig().defaults.max_steps, 150, 'old first-boot default follows the new one')
assert.equal(loadConfig().defaults.max_wall_s, 3 * 3600)
assert.equal(loadConfig().defaults.max_usd, 3, 'a real choice is kept')
console.log('  ok  installs on the old defaults get the new ones')

const db = openDb()
db.prepare(`INSERT INTO bots (id, name, created_at, updated_at) VALUES ('coder', 'C', 0, 0), ('shopper', 'S', 0, 0)`).run()
db.prepare(`UPDATE bots SET default_max_steps = 300, default_max_wall_s = 10800 WHERE id = 'coder'`).run()
const limits = (id: string) => db.prepare('SELECT max_steps, max_wall_s, max_usd FROM runs WHERE id = ?').get(id) as any
assert.deepEqual({ ...limits(createRun(db, { bot_id: 'coder', goal: 'g' })) }, { max_steps: 300, max_wall_s: 10800, max_usd: 3 })
assert.deepEqual({ ...limits(createRun(db, { bot_id: 'shopper', goal: 'g' })) }, { max_steps: 150, max_wall_s: 10800, max_usd: 3 })
assert.equal(limits(createRun(db, { bot_id: 'coder', goal: 'g', max_steps: 20 })).max_steps, 20, 'the message wins')
console.log('  ok  a run takes the message\'s limits, then the bot\'s, then Settings')
console.log('\nall passed')
