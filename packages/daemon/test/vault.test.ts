/** The fill tool's guarantees: secrets go only to their own site, never back to the model. */
import { strict as assert } from 'node:assert'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'grokked-vault-'))
process.env.XDG_CONFIG_HOME = dir
process.env.XDG_DATA_HOME = dir
process.env.GROKKED_DB = join(dir, 'test.db')

const { ensureDirs } = await import('../src/config.ts')
ensureDirs()
const { openDb } = await import('../src/db/index.ts')
const { vault, decrypt, encrypt } = await import('../src/vault.ts')
const { TOOLS_BY_NAME } = await import('../src/tools/registry.ts')

const db = openDb()
const SECRET = 'correct horse battery staple'
assert.equal(decrypt(encrypt(SECRET)), SECRET)
console.log('  ok  encrypts and decrypts')

const cred = vault.create(db, { url: 'https://www.linkedin.com/login', username: 'al', password: SECRET, bot_ids: ['bot-a'] })
assert.equal(cred.domain, 'linkedin.com')
assert.ok(!JSON.stringify(vault.list(db)).includes(SECRET))
console.log('  ok  listings never carry the secret')

let pageUrl = 'https://evil-linkedin.com/login'
const typed: string[] = []
const runtime: any = {
  act: async (action: string, args: any) => {
    if (action === 'page_info') return { ok: true, url: pageUrl }
    if (action === 'type') { typed.push(args.text); return { ok: true, url: pageUrl, value_now: args.text } }
    throw new Error(action)
  },
}
const fill = TOOLS_BY_NAME.get('browser_fill_credential')!.run!
const args = { credential_id: cred.id, field: 'password', ref: 's1e2', element: 'Password' }

let out: any = await fill(args, { runtime, runId: 'r', botId: 'bot-a', db })
assert.equal(out.error, 'wrong_site'); assert.equal(typed.length, 0)
console.log('  ok  refuses a lookalike site')

out = await fill(args, { runtime, runId: 'r', botId: 'bot-b', db })
assert.equal(out.error, 'no_such_credential'); assert.equal(typed.length, 0)
console.log('  ok  refuses a bot it was not shared with')

pageUrl = 'https://www.linkedin.com/login'
out = await fill(args, { runtime, runId: 'r', botId: 'bot-a', db })
assert.equal(out.ok, true); assert.deepEqual(typed, [SECRET])
assert.ok(!JSON.stringify(out).includes(SECRET))
console.log('  ok  types on its own site, and the result hides the value')

// ---- sign in with Google: the site's login points at a provider account
const google = vault.create(db, { label: 'Google', url: 'https://accounts.google.com', username: 'al@gmail.com', password: 'g-secret' })
const site = vault.create(db, { label: 'Acme', url: 'https://acme.example', sign_in_with: 'google', via_credential_id: google.id, password: 'ignored' })
assert.equal(site.has_secret, false)  // an SSO site keeps no password of its own
const steps = vault.forBotWithSteps(db, 'bot-a').find((c: any) => c.id === site.id) as any
assert.equal(steps.sign_in_with, 'Google'); assert.equal(steps.provider_account.id, google.id)
assert.match(steps.how_to_sign_in, /Continue with Google/)
assert.ok(!JSON.stringify(vault.forBotWithSteps(db, 'bot-a')).includes('g-secret'))
console.log('  ok  an SSO site lists its provider account and the steps, no secrets')

pageUrl = 'https://acme.example/login'
out = await fill({ credential_id: site.id, field: 'password', ref: 's1e2', element: 'Password' }, { runtime, runId: 'r', botId: 'bot-a', db })
assert.equal(out.error, 'sign_in_with_provider'); assert.match(out.message, new RegExp(google.id))
console.log('  ok  asking for an SSO site password points at the provider instead')

out = await fill({ credential_id: google.id, field: 'password', ref: 's1e2', element: 'Password' }, { runtime, runId: 'r', botId: 'bot-a', db })
assert.equal(out.error, 'wrong_site')
pageUrl = 'https://accounts.google.com/signin/v2'
out = await fill({ credential_id: google.id, field: 'password', ref: 's1e2', element: 'Password' }, { runtime, runId: 'r', botId: 'bot-a', db })
assert.equal(out.ok, true); assert.equal(typed.at(-1), 'g-secret')
console.log("  ok  the Google password is typed only on Google's pages")

console.log('\nall passed')
