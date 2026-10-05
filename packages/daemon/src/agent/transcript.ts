import type { Db } from '../db/index.ts'

/** One line of the chat as the app draws it. Mirrors what the live WS events
 *  produce, so a reloaded conversation looks the same as one you watched. */
export interface Entry {
  kind: 'goal' | 'say' | 'tool' | 'done' | 'ask' | 'error'
  text: string
  tool?: string
  status?: string
  step?: number
  run_id: string
}

/** The same one-line summary the live run.step event carries. */
export const toolSummary = (args: any): string =>
  String(args?.element ?? args?.url ?? args?.command ?? args?.query ?? '')

/**
 * Rebuilds a conversation from SQLite. Human messages are user rows with
 * step_no 0 (a request) or NULL (a reply mid-run); other user rows are nudges
 * and screenshots the human never typed.
 */
export function buildTranscript(db: Db, threadId: string): Entry[] {
  const runs = db.prepare(
    'SELECT id, state, state_reason FROM runs WHERE thread_id = ? ORDER BY created_at',
  ).all(threadId) as Array<{ id: string; state: string; state_reason: string | null }>

  const out: Entry[] = []
  for (const run of runs) {
    const msgs = db.prepare(
      'SELECT role, content_json, step_no FROM messages WHERE run_id = ? ORDER BY seq',
    ).all(run.id) as Array<{ role: string; content_json: string; step_no: number | null }>
    const steps = new Map(
      (db.prepare(
        `SELECT step_no, tool_name, status, args_json FROM run_steps WHERE run_id = ? AND kind = 'tool_call'`,
      ).all(run.id) as Array<{ step_no: number; tool_name: string; status: string; args_json: string | null }>)
        .map((s) => [s.step_no, s]),
    )

    let ended = false
    for (const m of msgs) {
      const content = JSON.parse(m.content_json)
      if (m.role === 'user') {
        if ((m.step_no === 0 || m.step_no === null) && typeof content === 'string') {
          out.push({ kind: 'goal', text: content, run_id: run.id })
        }
        continue
      }
      if (m.role !== 'assistant') continue

      const text = typeof content === 'string' ? content : content?.content
      if (text) out.push({ kind: 'say', text, run_id: run.id })

      const call = content?.tool_calls?.[0]
      if (call) {
        const args = safeJson(call.function?.arguments)
        const name = call.function?.name
        if (name === 'finish') { out.push({ kind: 'done', text: String(args.summary ?? ''), run_id: run.id }); ended = true }
        else if (name === 'give_up') { out.push({ kind: 'error', text: `gave up — ${args.reason ?? ''}`, run_id: run.id }); ended = true }
        else if (name === 'ask_human') out.push({ kind: 'ask', text: String(args.question ?? ''), run_id: run.id })
      }

      const st = m.step_no != null ? steps.get(m.step_no) : undefined
      if (st) {
        out.push({
          kind: 'tool', tool: st.tool_name, status: st.status === 'error' ? 'error' : 'ok',
          step: st.step_no, text: toolSummary(safeJson(st.args_json)), run_id: run.id,
        })
      }
    }

    if (!ended && ['failed', 'cancelled'].includes(run.state)) {
      out.push({
        kind: 'error',
        text: run.state === 'cancelled' ? 'stopped' : `failed${run.state_reason ? ` — ${run.state_reason}` : ''}`,
        run_id: run.id,
      })
    }
  }
  return out
}

function safeJson(s: string | null | undefined): any {
  try { return JSON.parse(s || '{}') } catch { return {} }
}
