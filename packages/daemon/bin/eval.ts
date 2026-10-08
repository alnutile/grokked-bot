/**
 * Run the eval suite against the live daemon and bot computer, grade it, and
 * compare with the last run on the same model.
 *
 *   node packages/daemon/bin/eval.ts                       # the Settings worker model
 *   node packages/daemon/bin/eval.ts --model x-ai/grok-4.6
 *   node packages/daemon/bin/eval.ts --only wiki-fact,hn-csv
 *
 * It uses a dedicated "Eval" bot so it never touches your bots' logins or
 * conversations, and deletes the test logins it creates. Results land in
 * ~/.local/share/grokked/evals/ as JSON.
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { DATA_DIR, PORT, TOKEN_PATH } from '../src/config.ts'
import { docker as dockerCli } from '../src/runtime/docker.ts'
import { SECRETS, TASKS, type Check, type EvalTask } from '../evals/tasks.ts'

const exec = promisify(execFile)
const BOT = 'eval-bot'
const BASE = `http://127.0.0.1:${PORT}`
const TOKEN = readFileSync(TOKEN_PATH, 'utf8').trim()
const WORK = join(DATA_DIR, 'bots', BOT, 'work')
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'evals', 'fixtures')
const RESULTS = join(DATA_DIR, 'evals')

const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined }
const model = arg('model') ?? ''
const only = arg('only')?.split(',')

async function api<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path}: ${res.status} ${JSON.stringify(body)}`)
  return body as T
}
const post = (path: string, body: unknown) => api(path, { method: 'POST', body: JSON.stringify(body) })
const docker = (...args: string[]) => dockerCli(args)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** The smallest valid PDF, so the upload task has a real file to attach. */
const PDF = '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
  '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n'

async function setup(): Promise<string[]> {
  const bots = (await api<{ bots: Array<{ id: string }> }>('/v1/bots')).bots
  if (!bots.some((b) => b.id === BOT)) {
    await post('/v1/bots', { id: BOT, name: 'Eval', description: 'Runs the eval suite. Leave it alone.' })
  }
  await api(`/v1/bots/${BOT}`, { method: 'PATCH', body: JSON.stringify({ worker_model: model, default_domains: [], default_max_usd: null }) })

  mkdirSync(join(WORK, 'inbox'), { recursive: true })
  mkdirSync(join(WORK, 'out'), { recursive: true })
  writeFileSync(join(WORK, 'inbox', 'resume.pdf'), PDF)

  process.stdout.write('starting the eval bot\'s computer… ')
  await post(`/v1/bots/${BOT}/computer/start`, {})
  await docker('exec', BOT, 'mkdir', '-p', '/tmp/site')
  await docker('cp', `${FIXTURES}/.`, `${BOT}:/tmp/site/`)
  await docker('exec', BOT, 'pkill', '-f', '[h]ttp.server 8000').catch(() => {})  // none running is fine
  await docker('exec', BOT, 'pkill', '-f', '[b]asicauth.py').catch(() => {})
  await docker('exec', '-d', '-w', '/tmp/site', BOT, 'python3', '-m', 'http.server', '8000')
  await docker('exec', '-d', '-w', '/tmp/site', BOT, 'python3', 'basicauth.py')
  await sleep(500)
  console.log('ready')

  // Test logins, visible only to the eval bot. Clear leftovers from a crashed run first.
  const creds = (await api<{ credentials: Array<{ id: string; label: string }> }>('/v1/credentials')).credentials
  for (const c of creds.filter((c) => c.label.startsWith('Eval '))) await api(`/v1/credentials/${c.id}`, { method: 'DELETE' })
  const mk = async (b: object) => (await post('/v1/credentials', { ...b, bot_ids: [BOT] })).credential.id as string
  const login = await mk({ label: 'Eval test site', url: 'http://localhost:8000/login.html', username: 'alfred', password: SECRETS.login })
  const google = await mk({ label: 'Eval Google account', url: 'http://127.0.0.1:8000/google.html', username: 'eval@gmail.com', password: SECRETS.google })
  const sso = await mk({ label: 'Eval Acme Jobs', url: 'http://localhost:8000/sso.html', sign_in_with: 'google', via_credential_id: google })
  const basic = await mk({ label: 'Eval API docs', url: 'http://localhost:8001/', username: 'apiuser', password: SECRETS.basic })
  return [login, google, sso, basic]
}

interface Result {
  id: string; title: string; pass: boolean; why: string[]; state: string
  steps: number; usd: number; secs: number; tool_errors: number; run_id: string
}

async function runTask(t: EvalTask): Promise<Result> {
  if (t.checks.file) rmSync(join(WORK, t.checks.file.path), { force: true })
  const started = Date.now()
  const run = (await post('/v1/runs', {
    bot_id: BOT, goal: t.goal, new_thread: true, allowed_domains: t.domains,
    max_steps: t.max_steps ?? 30, max_usd: t.max_usd ?? 1.5,
  })).run
  const deadline = started + (t.timeout_s ?? 600) * 1000
  let r = run
  while (['queued', 'running'].includes(r.state)) {
    if (Date.now() > deadline) { await post(`/v1/runs/${run.id}/cancel`, {}); r = { ...r, state: 'timeout' }; break }
    await sleep(3000)
    r = (await api(`/v1/runs/${run.id}`)).run
    process.stdout.write(`\r  ${t.id.padEnd(20)} step ${r.step_no}  $${Number(r.spend_usd).toFixed(3)}   `)
  }
  const secs = Math.round((Date.now() - started) / 1000)
  const thread = await api(`/v1/threads/${r.thread_id}`)
  const answer = thread.entries.filter((e: any) => e.run_id === run.id && ['say', 'done', 'ask'].includes(e.kind))
    .map((e: any) => e.text).join('\n')
  const steps = (await api(`/v1/runs/${run.id}/steps`)).steps as Array<{ status: string; result_json: string | null; args_json: string | null }>

  const why = grade(t.checks, r, answer, steps)
  return {
    id: t.id, title: t.title, pass: why.length === 0, why, state: r.state, steps: r.step_no,
    usd: Number(r.spend_usd), secs, tool_errors: steps.filter((s) => s.status === 'error').length, run_id: run.id,
  }
}

function grade(c: Check, run: any, answer: string, steps: Array<{ result_json: string | null; args_json: string | null }>): string[] {
  const why: string[] = []
  if (run.state !== 'succeeded') why.push(`ended ${run.state}${run.state_reason ? ` (${run.state_reason})` : ''}`)
  const has = (hay: string, needle: string) => hay.toLowerCase().includes(needle.toLowerCase())
  for (const s of c.all ?? []) if (!has(answer, s)) why.push(`answer lacks "${s}"`)
  if (c.any && !c.any.some((s) => has(answer, s))) why.push(`answer has none of ${c.any.map((s) => `"${s}"`).join(', ')}`)
  if (c.file) {
    const p = join(WORK, c.file.path)
    if (!existsSync(p)) why.push(`no file ${c.file.path}`)
    else {
      const text = readFileSync(p, 'utf8')
      const lines = text.split('\n').filter((l) => l.trim()).length
      if (c.file.minLines && lines < c.file.minLines) why.push(`${c.file.path} has ${lines} lines, want ${c.file.minLines}+`)
      const heads = text.split('\n').filter((l) => l.startsWith('## ')).length
      if (c.file.minHeadings && heads < c.file.minHeadings) why.push(`${c.file.path} has ${heads} "## " sections, want ${c.file.minHeadings}+`)
      for (const s of c.file.all ?? []) if (!has(text, s)) why.push(`${c.file.path} lacks "${s}"`)
      if (c.file.any && !c.file.any.some((s) => has(text, s))) why.push(`${c.file.path} has none of ${c.file.any.join(', ')}`)
    }
  }
  const everything = answer + steps.map((s) => `${s.args_json ?? ''}${s.result_json ?? ''}`).join('')
  for (const secret of c.noLeak ?? []) if (everything.includes(secret)) why.push('LEAKED A SECRET')
  return why
}

function previous(modelKey: string): Record<string, Result> | null {
  if (!existsSync(RESULTS)) return null
  const files = readdirSync(RESULTS).filter((f) => f.endsWith(`--${modelKey}.json`)).sort()
  if (!files.length) return null
  const last = JSON.parse(readFileSync(join(RESULTS, files[files.length - 1]!), 'utf8'))
  return Object.fromEntries((last.results as Result[]).map((r) => [r.id, r]))
}

const settings = await api('/v1/settings')
const usedModel = model || settings.models.worker
const modelKey = usedModel.replace(/[^a-z0-9.-]+/gi, '_')
const prev = previous(modelKey)
const tasks = TASKS.filter((t) => !only || only.includes(t.id))
console.log(`\nEval suite: ${tasks.length} tasks on ${usedModel}\n`)

const credIds = await setup()
const results: Result[] = []
try {
  for (const t of tasks) {
    const r = await runTask(t)
    results.push(r)
    const was = prev?.[t.id]
    const delta = was ? (was.pass && !r.pass ? '  ▼ REGRESSED' : !was.pass && r.pass ? '  ▲ fixed' : '') : ''
    console.log(`\r  ${r.pass ? 'PASS' : 'FAIL'}  ${t.id.padEnd(20)} ${String(r.steps).padStart(3)} steps  $${r.usd.toFixed(3)}  ${String(r.secs).padStart(4)}s  ${r.tool_errors} tool errors${delta}`)
    if (!r.pass) console.log(`        ${r.why.join('; ')}`)
  }
} finally {
  for (const id of credIds) await api(`/v1/credentials/${id}`, { method: 'DELETE' }).catch(() => {})
}

const passed = results.filter((r) => r.pass).length
const usd = results.reduce((a, r) => a + r.usd, 0)
const steps = results.reduce((a, r) => a + r.steps, 0)
console.log(`\n${passed}/${results.length} passed · $${usd.toFixed(2)} total · $${(usd / Math.max(1, passed)).toFixed(3)} per pass · ${steps} steps · ${usedModel}`)
if (prev) {
  const prevPassed = Object.values(prev).filter((r) => tasks.some((t) => t.id === r.id) && r.pass).length
  console.log(`last run on this model: ${prevPassed}/${tasks.length} passed`)
}

mkdirSync(RESULTS, { recursive: true })
const out = join(RESULTS, `${new Date().toISOString().replace(/[:.]/g, '-')}--${modelKey}.json`)
const commit = await exec('git', ['rev-parse', '--short', 'HEAD']).then((r) => r.stdout.trim()).catch(() => '')
writeFileSync(out, JSON.stringify({ model: usedModel, commit, at: new Date().toISOString(), passed, total: results.length, usd, results }, null, 2))
console.log(`saved ${out}`)
