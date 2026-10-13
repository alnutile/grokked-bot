/** A bot's SSH key: real OpenSSH format, encrypted at rest, never sent back out. */
import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'grokked-ssh-'))
process.env.GROKKED_CONFIG_DIR = join(dir, 'config')
process.env.GROKKED_DATA_DIR = join(dir, 'data')
process.env.GROKKED_RUNTIME_DIR = join(dir, 'run')

const { ensureDirs } = await import('../src/config.ts')
ensureDirs()
const { openDb } = await import('../src/db/index.ts')
const { generateKey, fingerprint, cleanHosts, botSsh } = await import('../src/ssh.ts')
const { Hono } = await import('hono')
const { mountBots } = await import('../src/http/bots.ts')

// ssh-keygen accepts the key and derives the same public half and fingerprint.
const k = generateKey('grokked-test')
assert.match(k.publicKey, /^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5\S+ grokked-test$/)
let keygen = true
try { execFileSync('ssh-keygen', ['-V'], { stdio: 'ignore' }) } catch (e) { keygen = (e as { code?: string }).code !== 'ENOENT' }
if (keygen) {
  const f = join(dir, 'id'); writeFileSync(f, k.privateKey, { mode: 0o600 })
  assert.equal(execFileSync('ssh-keygen', ['-y', '-f', f]).toString().trim(), k.publicKey)
  writeFileSync(`${f}.pub`, k.publicKey + '\n')
  assert.ok(execFileSync('ssh-keygen', ['-lf', `${f}.pub`]).toString().includes(fingerprint(k.publicKey)))
  console.log('  ok  ssh-keygen reads the key and agrees on the fingerprint')
} else console.log('  --  ssh-keygen not installed; skipped the format check')

assert.deepEqual(cleanHosts([
  { name: ' web ', target: 'deploy@web.example.com' },
  { target: 'db.internal', port: 2222, note: 'read only' },
  { target: 'x; rm -rf /' }, { target: '' }, { target: 'root@[::1]', port: 22 },
]), [
  { name: 'web', target: 'deploy@web.example.com' },
  { name: 'db.internal', target: 'db.internal', port: 2222, note: 'read only' },
  { name: 'root@[::1]', target: 'root@[::1]' },
])
console.log('  ok  servers must be user@host; anything shell-ish is dropped')

const db = openDb()
db.prepare(`INSERT INTO bots (id, name, persona_md, autonomy, status, created_at, updated_at) VALUES ('b1', 'Web Ops', '', 'supervised', 'active', 0, 0)`).run()
const app = new Hono()
mountBots(app, db)
const call = async (method: string, path: string, body?: unknown) => {
  const r = await app.request(path, { method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
  return { status: r.status, text: await r.text() }
}

assert.equal(JSON.parse((await call('GET', '/v1/bots/b1/ssh')).text).public_key, '')
const made = await call('POST', '/v1/bots/b1/ssh/key')
assert.equal(made.status, 201)
const info = JSON.parse(made.text)
assert.match(info.public_key, / grokked-web-ops$/)
assert.ok(!made.text.includes('PRIVATE'), 'the API never returns the private key')
const stored = (db.prepare("SELECT ssh_key_enc FROM bots WHERE id='b1'").get() as { ssh_key_enc: string }).ssh_key_enc
assert.ok(stored && !stored.includes('PRIVATE'), 'stored encrypted')
assert.match(botSsh.privateKey(db, 'b1'), /BEGIN OPENSSH PRIVATE KEY/)
console.log('  ok  key made, stored encrypted, only the public half goes out')

const rotated = JSON.parse((await call('POST', '/v1/bots/b1/ssh/key')).text)
assert.notEqual(rotated.public_key, info.public_key)
const hosts = JSON.parse((await call('PUT', '/v1/bots/b1/ssh/hosts', { hosts: [{ name: 'web', target: 'deploy@web' }, { target: '$(id)' }] })).text).hosts
assert.deepEqual(hosts, [{ name: 'web', target: 'deploy@web' }])
const removed = JSON.parse((await call('DELETE', '/v1/bots/b1/ssh/key')).text)
assert.equal(removed.public_key, '')
assert.equal(botSsh.privateKey(db, 'b1'), '')
assert.equal(removed.hosts.length, 1, 'removing the key keeps the server list')
assert.equal((await call('GET', '/v1/bots/nope/ssh')).status, 404)
console.log('  ok  rotate replaces it, remove clears it, servers saved')

console.log('\nall passed')
