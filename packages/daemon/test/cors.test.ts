/** Every method a /v1 route uses passes the UI's CORS preflight. (PUT was missing, so
 *  saving a bot's Env failed in the app with "Load failed".) */
import { strict as assert } from 'node:assert'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cors } from 'hono/cors'

const { CORS_METHODS } = await import('../src/http/app.ts')
const { Hono } = await import('hono')

const dir = join(import.meta.dirname, '../src/http')
const used = new Set<string>()
for (const f of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
  for (const m of readFileSync(join(dir, f), 'utf8').matchAll(/app\.(get|post|put|patch|delete)\(\s*'\/v1\//g)) used.add(m[1]!.toUpperCase())
}
assert.ok(used.has('PUT'), 'found the routes')
for (const m of used) assert.ok(CORS_METHODS.includes(m), `${m} is used by a /v1 route but not allowed by CORS`)
console.log(`  ok  CORS allows every method the routes use (${[...used].sort().join(', ')})`)

const app = new Hono()
app.use('/v1/*', cors({ origin: (o) => o, allowMethods: CORS_METHODS }))
app.put('/v1/x', (c) => c.json({ ok: true }))
const pre = await app.request('/v1/x', { method: 'OPTIONS', headers: { origin: 'http://localhost:1420', 'access-control-request-method': 'PUT' } })
assert.match(pre.headers.get('access-control-allow-methods') ?? '', /PUT/)
console.log('  ok  a PUT preflight is answered with PUT allowed')
console.log('\nall passed')
