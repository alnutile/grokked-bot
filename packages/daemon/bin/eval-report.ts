/**
 * Compare models on the eval suite: the latest full run for each, side by side.
 *
 *   node packages/daemon/bin/eval-report.ts
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from '../src/config.ts'
import { TASKS } from '../evals/tasks.ts'

interface Result { id: string; pass: boolean; steps: number; usd: number; secs: number; why: string[] }
interface Run { model: string; commit: string; at: string; passed: number; total: number; usd: number; results: Result[] }

const dir = join(DATA_DIR, 'evals')
if (!existsSync(dir)) { console.log('No eval runs yet: pnpm eval'); process.exit(0) }

// Latest full-suite run per model (subset runs are for debugging). A run from
// before a task was added still counts; its missing tasks show as —.
const latest = new Map<string, Run>()
for (const f of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
  const run = JSON.parse(readFileSync(join(dir, f), 'utf8')) as Run
  if (run.total >= Math.min(10, TASKS.length)) latest.set(run.model, run)
}
if (!latest.size) { console.log('No full-suite runs yet: pnpm eval'); process.exit(0) }

const runs = [...latest.values()].sort((a, b) => b.passed - a.passed || a.usd - b.usd)
const money = (n: number) => `$${n.toFixed(2)}`

console.log(`\nLatest full run per model (the suite has ${TASKS.length} tasks now), best value first\n`)
console.log('model'.padEnd(30), 'pass'.padStart(6), 'total $'.padStart(9), '$ / pass'.padStart(9), 'steps'.padStart(6), 'time'.padStart(7), '  commit   date')
for (const r of runs) {
  const steps = r.results.reduce((a, x) => a + x.steps, 0)
  const secs = r.results.reduce((a, x) => a + x.secs, 0)
  console.log(
    r.model.padEnd(30), `${r.passed}/${r.total}`.padStart(6), money(r.usd).padStart(9),
    money(r.usd / Math.max(1, r.passed)).padStart(9), String(steps).padStart(6),
    `${Math.round(secs / 60)}m`.padStart(7), ` ${r.commit.padEnd(8)} ${r.at.slice(0, 10)}`,
  )
}

console.log('\nPer task: pass and cost\n')
const short = (m: string) => m.split('/').pop()!.slice(0, 16)
console.log('task'.padEnd(22), ...runs.map((r) => short(r.model).padStart(17)))
for (const t of TASKS) {
  const cells = runs.map((r) => {
    const x = r.results.find((y) => y.id === t.id)
    return (x ? `${x.pass ? '✓' : '✗'} ${money(x.usd)} ${x.steps}st` : '—').padStart(17)
  })
  console.log(t.id.padEnd(22), ...cells)
}

const failures = runs.flatMap((r) => r.results.filter((x) => !x.pass).map((x) => `  ${short(r.model)} · ${x.id}: ${x.why.join('; ')}`))
if (failures.length) console.log(`\nFailures\n${failures.join('\n')}`)
console.log()
