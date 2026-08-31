/** Hand a bot a job and watch it work. Usage: task.ts "<goal>" [domain ...] */
import { randomUUID } from 'node:crypto'
import { ensureDirs, loadConfig } from '../src/config.ts'
import { openDb } from '../src/db/index.ts'
import { EventBus } from '../src/events.ts'
import { validateModels } from '../src/model/openrouter.ts'
import { LocalDockerRuntime } from '../src/runtime/container.ts'
import { createRun, executeStep } from '../src/agent/loop.ts'

const goal = process.argv[2]
if (!goal) { console.error('usage: task.ts "<goal>" [allowed-domain ...]'); process.exit(1) }
const domains = process.argv.slice(3)

ensureDirs()
const db = openDb()
const bus = new EventBus(db)
const cfg = loadConfig()
await validateModels(Object.values(cfg.models))

const BOT = 'bot-alpha'
if (!db.prepare('SELECT 1 FROM bots WHERE id = ?').get(BOT)) {
  const t = Date.now()
  db.prepare(`INSERT INTO bots (id, name, persona_md, autonomy, status, created_at, updated_at)
              VALUES (?, 'Alpha', '', 'supervised', 'active', ?, ?)`).run(BOT, t, t)
}

const runtime = new LocalDockerRuntime(BOT)
const runId = createRun(db, { bot_id: BOT, goal, allowed_domains: domains })
console.log(`run ${runId}\nmodel ${cfg.models.worker}\ndomains ${domains.join(', ') || '(any)'}\n`)

bus.subscribe((f) => {
  const d = f.data as any
  if (f.type === 'run.step' && d.kind === 'llm_call') {
    if (d.text) console.log(`\x1b[36m  ${String(d.text).trim().slice(0, 400)}\x1b[0m`)
  }
  if (f.type === 'run.step' && d.kind === 'tool_call') {
    const mark = d.status === 'error' ? '\x1b[31m✗\x1b[0m' : '\x1b[32m✓\x1b[0m'
    console.log(`  ${mark} ${String(d.step_no).padStart(2)} ${d.tool_name} ${String(d.summary).slice(0, 90)}`)
  }
  if (f.type === 'run.finished') console.log(`\n\x1b[1m${d.outcome}\x1b[0m: ${d.summary}`)
})

for (;;) {
  const out = await executeStep(db, bus, runtime, runId)
  if (out.done) {
    const r = db.prepare('SELECT step_no, spend_usd, prompt_tokens, completion_tokens FROM runs WHERE id = ?')
      .get(runId) as any
    console.log(`\nstate=${out.state} steps=${r.step_no} cost=$${Number(r.spend_usd).toFixed(4)} ` +
                `tokens=${r.prompt_tokens}/${r.completion_tokens}`)
    if (out.reason && out.state !== 'succeeded') console.log(`reason: ${out.reason}`)
    break
  }
}
db.close()
