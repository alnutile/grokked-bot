/** A bot's environment variables: pasted .env files parse, reach the shell, and never reach the model. */
import { strict as assert } from 'node:assert'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'grokked-env-'))
process.env.XDG_CONFIG_HOME = dir
process.env.XDG_DATA_HOME = dir
process.env.GROKKED_DB = join(dir, 'test.db')

const { ensureDirs } = await import('../src/config.ts')
ensureDirs()
const { openDb } = await import('../src/db/index.ts')
const { botEnv, parseDotenv, redactEnv, toDotenv } = await import('../src/env.ts')
const { TOOLS_BY_NAME } = await import('../src/tools/registry.ts')
const { shapeBot } = await import('../src/http/bots.ts')

const parsed = parseDotenv([
  '# a comment',
  'export GITHUB_TOKEN=github_pat_11ABCDEFG0123456789',
  'NODE_ENV=production  # inline comment',
  "SINGLE='literal $HOME \\n'",
  'DOUBLE="line one\\nline two"',
  'MULTI="-----BEGIN KEY-----',
  'abc',
  '-----END KEY-----"',
  'EMPTY=',
  'PATH=/evil',
  '1BAD=x',
  'not a variable',
  'NODE_ENV=staging',
].join('\n'))
const get = (k: string) => parsed.vars.find((v) => v.key === k)?.value
assert.equal(get('GITHUB_TOKEN'), 'github_pat_11ABCDEFG0123456789')
assert.equal(get('NODE_ENV'), 'staging', 'later keys win')
assert.equal(get('SINGLE'), 'literal $HOME \\n')
assert.equal(get('DOUBLE'), 'line one\nline two')
assert.equal(get('MULTI'), '-----BEGIN KEY-----\nabc\n-----END KEY-----')
assert.equal(get('EMPTY'), '')
assert.equal(get('PATH'), undefined)
assert.equal(parsed.skipped.length, 3, parsed.skipped.join(' | '))
console.log('  ok  parses a pasted .env file')

assert.deepEqual(parseDotenv(toDotenv(parsed.vars)).vars, parsed.vars)
console.log('  ok  round-trips through the editor')

const db = openDb()
db.prepare(`INSERT INTO bots (id, name, created_at, updated_at) VALUES ('bot-a', 'A', 0, 0)`).run()
botEnv.set(db, 'bot-a', parsed.vars)
const raw = db.prepare(`SELECT * FROM bots WHERE id = 'bot-a'`).get() as any
assert.ok(raw.env_enc.startsWith('v1:') && !raw.env_enc.includes('github_pat'))
assert.ok(!('env_enc' in shapeBot(raw)))
assert.deepEqual(botEnv.get(db, 'bot-a'), parsed.vars)
console.log('  ok  stored encrypted, kept out of the bot listing')

const shell = botEnv.forShell(db, 'bot-a')
assert.equal(shell.GH_TOKEN, 'github_pat_11ABCDEFG0123456789')
assert.equal(shell.GIT_CONFIG_KEY_0, 'credential.https://github.com.helper')
assert.ok(!shell.GIT_CONFIG_VALUE_0!.includes('github_pat'), 'the helper reads the variable, not a copy')
console.log('  ok  a GitHub token sets up git and gh')

let sent: any
const runtime: any = {
  act: async (action: string, args: any) => {
    sent = { action, ...args }
    return { ok: true, stdout: `GITHUB_TOKEN=${args.env.GITHUB_TOKEN}\nNODE_ENV=${args.env.NODE_ENV}\n` }
  },
}
const out: any = await TOOLS_BY_NAME.get('run_bash')!.run!({ command: 'env' }, { runtime, runId: 'r', botId: 'bot-a', db })
assert.equal(sent.action, 'run_bash')
assert.equal(sent.env.NODE_ENV, 'staging')
const seen = redactEnv(out, botEnv.get(db, 'bot-a'))
assert.ok(!JSON.stringify(seen).includes('github_pat'))
assert.ok(seen.stdout.includes('GITHUB_TOKEN=[$GITHUB_TOKEN]'))
assert.ok(seen.stdout.includes('NODE_ENV=staging'), 'plain values stay readable')
console.log('  ok  run_bash gets the variables; the model sees only names')

botEnv.set(db, 'bot-a', [])
assert.deepEqual(botEnv.forShell(db, 'bot-a'), {})
console.log('  ok  clearing removes them')
