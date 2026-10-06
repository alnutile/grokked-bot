import { randomUUID } from 'node:crypto'
import { createHash } from 'node:crypto'
import * as z from 'zod'
import type { Db } from '../db/index.ts'
import type { EventBus } from '../events.ts'
import { chat, ModelError, type ChatMessage, type ToolCall } from '../model/openrouter.ts'
import { loadConfig } from '../config.ts'
import { log } from '../log.ts'
import type { BotRuntime } from '../runtime/container.ts'
import { TOOLS_BY_NAME, toolDefs } from '../tools/registry.ts'
import { systemPrompt, wrapUntrusted } from './prompt.ts'
import { toolSummary } from './transcript.ts'

const now = () => Date.now()
const id = (p: string) => `${p}_${randomUUID().replaceAll('-', '').slice(0, 16)}`
const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16)

/** Only the two most recent screenshots stay as images; older ones collapse to a
 *  text stand-in. Without this a 30-step browser run re-sends ~40k tokens of
 *  stale pictures on every single call. */
const KEEP_IMAGES = 2
const TOOL_RESULT_CAP = 4000
/** A page snapshot has to arrive whole: the button you need is often near the
 *  end. Only the latest one is sent in full (see assembleMessages). */
const SNAPSHOT_RESULT_CAP = 46000  // the shim fits snapshots to 40k chars plus a section map
const SNAPSHOT_MARK = '# snapshot s'
/** Earlier requests in a conversation ride along as one exchange each. */
const HISTORY_RUNS = 20

export interface CreateRunInput {
  bot_id: string
  goal: string
  allowed_domains?: string[]
  max_steps?: number
  max_usd?: number
  /** Continue this conversation; omitted means start a new one. */
  thread_id?: string
}

/**
 * A conversation is a thread; each message the human sends starts a run in it.
 * Messages are tagged by step_no so the transcript can be rebuilt: 0 is the
 * request that started a run, NULL is a human reply mid-run (an answer to
 * ask_human, or "carry on" after a takeover), anything else came from a step.
 */
export function createThread(db: Db, botId: string, title = ''): string {
  const threadId = id('thr')
  db.prepare(
    `INSERT INTO threads (id, bot_id, kind, title, last_message_at, created_at)
     VALUES (?, ?, 'chat', ?, ?, ?)`,
  ).run(threadId, botId, title.slice(0, 120), now(), now())
  return threadId
}

/** A reply from the human to a run that stopped to wait for them. */
export function addHumanReply(db: Db, runId: string, text: string): void {
  const run = getRun(db, runId)
  if (!run) throw new Error(`no run ${runId}`)
  addMessage(db, run.thread_id, 'user', text, { run_id: runId })
}

export function createRun(db: Db, input: CreateRunInput): string {
  const cfg = loadConfig()
  const runId = id('run')
  const t = now()

  db.exec('BEGIN')
  try {
    const threadId = input.thread_id ?? createThread(db, input.bot_id)

    db.prepare(
      `INSERT INTO runs (id, bot_id, thread_id, trigger_kind, goal, allowed_domains_json,
                         state, max_steps, max_usd, max_wall_s, max_screenshots, created_at)
       VALUES (?, ?, ?, 'user', ?, ?, 'queued', ?, ?, ?, ?, ?)`,
    ).run(
      runId, input.bot_id, threadId, input.goal,
      JSON.stringify(input.allowed_domains ?? []),
      input.max_steps ?? cfg.defaults.max_steps,
      input.max_usd ?? cfg.defaults.max_usd,
      cfg.defaults.max_wall_s,
      cfg.defaults.max_screenshots,
      t,
    )
    addMessage(db, threadId, 'user', input.goal, { run_id: runId, step_no: 0 })
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
  return runId
}

type RunRow = {
  id: string; bot_id: string; thread_id: string; goal: string; state: string
  allowed_domains_json: string; step_no: number; max_steps: number; max_usd: number
  max_wall_s: number; screenshot_count: number; max_screenshots: number
  spend_usd: number; started_at: number | null; created_at: number
}

const getRun = (db: Db, runId: string) =>
  db.prepare('SELECT * FROM runs WHERE id = ?').get(runId) as RunRow | undefined

function setState(db: Db, bus: EventBus, runId: string, state: string, reason?: string): void {
  db.prepare('UPDATE runs SET state = ?, state_reason = ? WHERE id = ?').run(state, reason ?? null, runId)
  bus.emit({ topic: `run:${runId}`, type: 'run.state', run_id: runId, data: { run_id: runId, state, reason } })
}

function addMessage(
  db: Db, threadId: string, role: string, content: unknown,
  extra: { tool_call_id?: string; run_id?: string; step_no?: number } = {},
): void {
  const seq = Number(
    (db.prepare('SELECT COALESCE(MAX(seq),0)+1 AS n FROM messages WHERE thread_id = ?').get(threadId) as { n: number }).n,
  )
  const body = JSON.stringify(content)
  db.prepare(
    `INSERT INTO messages (id, thread_id, seq, role, content_json, tool_call_id, run_id, step_no, token_estimate, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id('msg'), threadId, seq, role, body, extra.tool_call_id ?? null,
        extra.run_id ?? null, extra.step_no ?? null, Math.round(body.length / 3.6), now())
  db.prepare('UPDATE threads SET last_message_at = ? WHERE id = ?').run(now(), threadId)
}

/**
 * Rebuilds the full model context from SQLite. This is why there is exactly one
 * code path for "next step": start, resume-after-crash, resume-after-approval and
 * wake-from-sleep all land here and none of them can tell the difference.
 */
function assembleMessages(db: Db, run: RunRow, botName: string, personaMd: string): ChatMessage[] {
  const rows = db
    .prepare('SELECT role, content_json, tool_call_id FROM messages WHERE run_id = ? ORDER BY seq ASC')
    .all(run.id) as Array<{ role: string; content_json: string; tool_call_id: string | null }>

  const msgs: ChatMessage[] = [{
    role: 'system',
    content: systemPrompt({
      botName,
      personaMd,
      goal: run.goal,
      allowedDomains: JSON.parse(run.allowed_domains_json) as string[],
      maxSteps: run.max_steps,
    }),
  }]

  // Earlier requests in this conversation, condensed to what was asked and how
  // it ended. Their tool calls and page dumps stay out: they cost tokens on
  // every step, and a finished run's last tool call has no result to pair with.
  const earlier = db.prepare(
    `SELECT goal, state, state_reason, outcome_summary FROM runs
     WHERE thread_id = ? AND created_at < ? AND id != ?
     ORDER BY created_at DESC LIMIT ?`,
  ).all(run.thread_id, run.created_at, run.id, HISTORY_RUNS) as Array<
    { goal: string; state: string; state_reason: string | null; outcome_summary: string | null }>
  for (const r of earlier.reverse()) {
    msgs.push({ role: 'user', content: r.goal })
    msgs.push({
      role: 'assistant',
      content: r.outcome_summary ?? `(that request ended ${r.state}${r.state_reason ? `: ${r.state_reason}` : ''})`,
    })
  }

  const parsed = rows.map((r) => ({ ...r, content: JSON.parse(r.content_json) as any }))

  // Only the latest page snapshot is worth its tokens; older ones are stale by
  // definition (their refs are rejected), so they collapse to a stub.
  const snapIdx = parsed
    .map((m, i) => (m.role === 'tool' && typeof m.content === 'string' && m.content.includes(SNAPSHOT_MARK) ? i : -1))
    .filter((i) => i >= 0)
  for (const i of snapIdx.slice(0, -1)) {
    const c = parsed[i]!.content as string
    parsed[i]!.content = c.slice(0, c.indexOf(SNAPSHOT_MARK)) + '[older page snapshot omitted; its refs are stale]'
  }
  const imageIdx = parsed
    .map((m, i) => (Array.isArray(m.content) && m.content.some((p: any) => p.type === 'image_url') ? i : -1))
    .filter((i) => i >= 0)
  const keep = new Set(imageIdx.slice(-KEEP_IMAGES))

  parsed.forEach((m, i) => {
    if (Array.isArray(m.content) && m.content.some((p: any) => p.type === 'image_url') && !keep.has(i)) {
      const label = m.content.find((p: any) => p.type === 'text')?.text ?? 'screenshot'
      msgs.push({ role: m.role as any, content: `[${label} — image dropped from context to save tokens]` })
      return
    }
    // An assistant turn with tool calls is stored as a {content, tool_calls}
    // wrapper; the wire format wants those as sibling fields, not as `content`.
    if (m.role === 'assistant' && m.content && typeof m.content === 'object'
        && !Array.isArray(m.content) && 'tool_calls' in m.content) {
      msgs.push({
        role: 'assistant',
        content: (m.content as any).content ?? null,
        tool_calls: (m.content as any).tool_calls,
      })
      return
    }
    msgs.push({
      role: m.role as any,
      content: m.content,
      ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
    } as ChatMessage)
  })
  return msgs
}

export interface StepOutcome { done: boolean; state: string; reason?: string }

export async function runToCompletion(
  db: Db, bus: EventBus, runtime: BotRuntime, runId: string,
): Promise<StepOutcome> {
  let guard = 0
  for (;;) {
    if (++guard > 500) return { done: true, state: 'failed', reason: 'guard' }
    const out = await executeStep(db, bus, runtime, runId)
    if (out.done) return out
  }
}

export async function executeStep(
  db: Db, bus: EventBus, runtime: BotRuntime, runId: string,
): Promise<StepOutcome> {
  const cfg = loadConfig()
  const run = getRun(db, runId)
  if (!run) return { done: true, state: 'failed', reason: 'no such run' }

  const bot = db.prepare('SELECT name, persona_md, model_roles_json FROM bots WHERE id = ?').get(run.bot_id) as
    { name: string; persona_md: string; model_roles_json: string } | undefined
  // A bot can override the worker model; otherwise Settings decides.
  const workerModel = (JSON.parse(bot?.model_roles_json || '{}') as { worker?: string }).worker || cfg.models.worker
  const botName = bot?.name ?? 'Bot'

  // ---- preflight: every cap is checked BEFORE spending, never after ----
  if (run.step_no >= run.max_steps) {
    setState(db, bus, runId, 'failed', 'step_budget')
    return { done: true, state: 'failed', reason: `hit step budget (${run.max_steps})` }
  }
  if (run.spend_usd >= run.max_usd) {
    setState(db, bus, runId, 'paused_budget', 'cost_cap')
    return { done: true, state: 'paused_budget', reason: `hit cost cap ($${run.max_usd})` }
  }
  if (run.started_at && now() - run.started_at > run.max_wall_s * 1000) {
    setState(db, bus, runId, 'failed', 'wall_clock')
    return { done: true, state: 'failed', reason: 'wall clock exceeded' }
  }
  if (await runtime.isHumanInControl()) {
    setState(db, bus, runId, 'sleeping', 'human_has_control')
    return { done: true, state: 'sleeping', reason: 'a human has taken over the computer' }
  }

  if (run.state === 'queued') {
    db.prepare('UPDATE runs SET state = ?, started_at = COALESCE(started_at, ?) WHERE id = ?')
      .run('running', now(), runId)
    await runtime.ensureUp()
    await runtime.setAllowedDomains(JSON.parse(run.allowed_domains_json) as string[])
    bus.emit({ topic: `run:${runId}`, type: 'run.state', run_id: runId, data: { run_id: runId, state: 'running' } })
  }

  const messages = assembleMessages(db, run, botName, bot?.persona_md ?? '')
  const stepNo = run.step_no + 1

  // ---- model call ----
  let result
  try {
    result = await chat({ model: workerModel, messages, tools: toolDefs() })
  } catch (e) {
    const err = e as ModelError
    log.error({ runId, err: err.message }, 'model call failed')
    if (err.retryable) {
      await new Promise((r) => setTimeout(r, 2000))
      return { done: false, state: 'running' }
    }
    setState(db, bus, runId, 'failed', `model_error: ${err.message.slice(0, 200)}`)
    return { done: true, state: 'failed', reason: err.message }
  }

  const cost = result.cost_usd
  db.exec('BEGIN')
  try {
    db.prepare(
      `INSERT INTO llm_calls (id, run_id, step_no, role, model, provider, gen_id, prompt_tokens,
                              completion_tokens, cached_tokens, cost_usd, latency_ms, finish_reason, created_at)
       VALUES (?, ?, ?, 'worker', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id('llm'), runId, stepNo, result.model, result.provider ?? null, result.id,
          result.usage.prompt_tokens, result.usage.completion_tokens,
          result.usage.prompt_tokens_details?.cached_tokens ?? 0,
          cost, result.latency_ms, result.finish_reason, now())
    db.prepare(
      `UPDATE runs SET step_no = ?, spend_usd = spend_usd + ?,
                       prompt_tokens = prompt_tokens + ?, completion_tokens = completion_tokens + ?
       WHERE id = ?`,
    ).run(stepNo, cost, result.usage.prompt_tokens, result.usage.completion_tokens, runId)
    // Persist ONLY the tool call we will actually execute. The API requires every
    // tool_call in an assistant message to be answered by a matching tool result,
    // so recording three and running one poisons the next turn.
    const executed = result.tool_calls.slice(0, 1)
    addMessage(db, run.thread_id, 'assistant',
      executed.length ? { content: result.content, tool_calls: executed } : result.content,
      { run_id: runId, step_no: stepNo })
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }

  bus.emit({
    topic: `run:${runId}`, type: 'run.step', run_id: runId,
    data: { run_id: runId, step_no: stepNo, kind: 'llm_call',
            text: result.content, tools: result.tool_calls.map((c) => c.function.name),
            cost_usd: cost, model: result.model },
  })

  // ---- no tool call: nudge once, then fail. A plain reply must not end a run. ----
  if (result.tool_calls.length === 0) {
    const nudged = db.prepare(
      `SELECT COUNT(*) AS n FROM run_steps WHERE run_id = ? AND kind = 'nudge'`,
    ).get(runId) as { n: number }
    if (Number(nudged.n) >= 1) {
      setState(db, bus, runId, 'failed', 'no_tool_call')
      return { done: true, state: 'failed', reason: 'model replied with text instead of finishing' }
    }
    db.prepare(`INSERT INTO run_steps (run_id, step_no, kind, status, started_at, ended_at)
                VALUES (?, ?, 'nudge', 'ok', ?, ?)`).run(runId, stepNo, now(), now())
    addMessage(db, run.thread_id, 'user',
      'You replied with text but did not call a tool. Continue the task, or call `finish` / `give_up` to end the run.',
      { run_id: runId, step_no: stepNo })
    return { done: false, state: 'running' }
  }

  const call = result.tool_calls[0]!
  return await dispatchTool(db, bus, runtime, run, stepNo, call)
}

async function dispatchTool(
  db: Db, bus: EventBus, runtime: BotRuntime, run: RunRow, stepNo: number, call: ToolCall,
): Promise<StepOutcome> {
  const tool = TOOLS_BY_NAME.get(call.function.name)
  const runId = run.id

  if (!tool) {
    addMessage(db, run.thread_id, 'tool', `Unknown tool ${call.function.name}.`,
      { tool_call_id: call.id, run_id: runId, step_no: stepNo })
    return { done: false, state: 'running' }
  }

  let args: any
  try {
    args = tool.schema.parse(JSON.parse(call.function.arguments || '{}'))
  } catch (e) {
    // Structured, recoverable errors beat a 500: tell it what was wrong so it can fix it.
    const msg = e instanceof z.ZodError
      ? `Invalid arguments for ${tool.name}: ${e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`
      : `Could not parse arguments for ${tool.name}: ${(e as Error).message}`
    addMessage(db, run.thread_id, 'tool', msg, { tool_call_id: call.id, run_id: runId, step_no: stepNo })
    return { done: false, state: 'running' }
  }

  // ---- terminal tools ----
  if (tool.control === 'finish') {
    db.prepare(`UPDATE runs SET outcome = ?, outcome_summary = ?, ended_at = ? WHERE id = ?`)
      .run(args.status, args.summary, now(), runId)
    setState(db, bus, runId, 'succeeded')
    bus.emit({ topic: `run:${runId}`, type: 'run.finished', run_id: runId,
               data: { run_id: runId, outcome: args.status, summary: args.summary,
                       artifacts: args.artifacts, spend_usd: run.spend_usd, steps: stepNo } })
    return { done: true, state: 'succeeded', reason: args.summary }
  }
  if (tool.control === 'give_up') {
    db.prepare(`UPDATE runs SET outcome = 'gave_up', outcome_summary = ?, ended_at = ? WHERE id = ?`)
      .run(args.reason, now(), runId)
    setState(db, bus, runId, 'failed', 'gave_up')
    bus.emit({ topic: `run:${runId}`, type: 'run.finished', run_id: runId,
               data: { run_id: runId, outcome: 'gave_up', summary: args.reason, steps: stepNo } })
    return { done: true, state: 'failed', reason: args.reason }
  }
  if (tool.control === 'ask_human') {
    // Answer the tool call so the run can continue later; the human's reply
    // arrives as the next user message. The question is kept on the run so the
    // transcript and later history can show it.
    addMessage(db, run.thread_id, 'tool', 'Your question is in front of the human. Their reply will be the next message.',
      { tool_call_id: call.id, run_id: runId, step_no: stepNo })
    db.prepare('UPDATE runs SET outcome_summary = ? WHERE id = ?').run(args.question, runId)
    setState(db, bus, runId, 'blocked', 'ask_human')
    bus.emit({ topic: `run:${runId}`, type: 'run.state', run_id: runId,
               data: { run_id: runId, state: 'blocked', question: args.question } })
    return { done: true, state: 'blocked', reason: args.question }
  }

  // ---- loop detector: the cheap backstop for everything unanticipated ----
  const sig = hash(`${tool.name}:${JSON.stringify(args)}`)
  const recent = db.prepare(
    `SELECT idem_key FROM run_steps WHERE run_id = ? AND kind = 'tool_call' ORDER BY step_no DESC LIMIT 5`,
  ).all(runId) as Array<{ idem_key: string | null }>
  const repeats = recent.filter((r) => r.idem_key === sig).length
  if (repeats >= 4) {
    setState(db, bus, runId, 'failed', 'repetition_loop')
    return { done: true, state: 'failed', reason: `called ${tool.name} with identical arguments 5 times` }
  }

  // ---- two-phase dispatch: record intent, act, record outcome ----
  db.prepare(
    `INSERT INTO run_steps (run_id, step_no, kind, status, tool_name, tool_call_id, args_json, idem_key, started_at)
     VALUES (?, ?, 'tool_call', 'dispatched', ?, ?, ?, ?, ?)`,
  ).run(runId, stepNo, tool.name, call.id, JSON.stringify(args), sig, now())

  let out: any
  try {
    out = await tool.run!(args, { runtime, runId, botId: run.bot_id, db })
  } catch (e) {
    out = { ok: false, error: 'tool_threw', message: (e as Error).message }
  }

  const isScreenshot = tool.name === 'browser_screenshot'
  const image = isScreenshot && out?.image_base64 ? String(out.image_base64) : null
  if (image) {
    delete out.image_base64
    db.prepare('UPDATE runs SET screenshot_count = screenshot_count + 1 WHERE id = ?').run(runId)
  }

  db.prepare(`UPDATE run_steps SET status = ?, result_json = ?, ended_at = ? WHERE run_id = ? AND step_no = ?`)
    .run(out?.ok === false ? 'error' : 'ok', JSON.stringify(out).slice(0, 20000), now(), runId, stepNo)

  // Page-derived text is attacker-controlled. Fence it so it reads as data.
  const pageText = typeof out?.text === 'string' ? out.text : null
  if (pageText) out = { ...out, text: wrapUntrusted(pageText) }
  const rendered = JSON.stringify(out)
  addMessage(db, run.thread_id, 'tool',
    rendered.length > (rendered.includes(SNAPSHOT_MARK) ? SNAPSHOT_RESULT_CAP : TOOL_RESULT_CAP)
      ? rendered.slice(0, rendered.includes(SNAPSHOT_MARK) ? SNAPSHOT_RESULT_CAP : TOOL_RESULT_CAP) +
        `\n…[truncated]`
      : rendered,
    { tool_call_id: call.id, run_id: runId, step_no: stepNo })

  // OpenAI-shaped tool results must be strings, so an image rides in as a
  // following user message rather than inside the tool result itself.
  if (image) {
    addMessage(db, run.thread_id, 'user', [
      { type: 'text', text: `screenshot at step ${stepNo}` },
      { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${image}` } },
    ], { run_id: runId, step_no: stepNo })
  }

  bus.emit({
    topic: `run:${runId}`, type: 'run.step', run_id: runId,
    data: { run_id: runId, step_no: stepNo, kind: 'tool_call', tool_name: tool.name,
            status: out?.ok === false ? 'error' : 'ok',
            summary: toolSummary(args) },
  })

  if (out?.error === 'human_has_control') {
    setState(db, bus, runId, 'sleeping', 'human_has_control')
    return { done: true, state: 'sleeping', reason: 'a human took over mid-run' }
  }
  return { done: false, state: 'running' }
}
