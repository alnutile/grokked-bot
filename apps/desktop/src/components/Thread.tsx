import { useEffect, useRef, useState } from 'react'
import { api, subscribe, type Frame, type Run } from '../api.ts'

export interface Entry {
  kind: 'goal' | 'say' | 'tool' | 'done' | 'error'
  text: string
  tool?: string
  status?: string
  step?: number
  cost?: number
}

const TOOL_VERB: Record<string, string> = {
  browser_navigate: 'opened', browser_snapshot: 'looked at the page',
  browser_click: 'clicked', browser_type: 'typed into', browser_find: 'searched for',
  browser_read_text: 'read the page', browser_scroll: 'scrolled',
  browser_wait_for: 'waited for', browser_screenshot: 'took a screenshot',
  run_bash: 'ran', write_file: 'wrote', desktop_action: 'used the desktop',
}

export function Thread({ botId, frames }: { botId: string; frames: Frame[] }) {
  const [entries, setEntries] = useState<Entry[]>([])
  const [run, setRun] = useState<Run | null>(null)
  const [goal, setGoal] = useState('')
  const [domains, setDomains] = useState('')
  const [budget, setBudget] = useState('')
  const [sending, setSending] = useState(false)
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [entries.length])

  // Poll the run row while it is live. The WS carries step events, but state,
  // step count and spend live on the run itself -- without this the header sits
  // at "queued  step 0/40  $0.0000" for the whole run.
  useEffect(() => {
    if (!run || !['queued', 'running'].includes(run.state)) return
    const t = setInterval(() => { void api.run(run.id).then(setRun).catch(() => {}) }, 1500)
    return () => clearInterval(t)
  }, [run?.id, run?.state])

  useEffect(() => {
    const latest = frames[frames.length - 1]
    if (!latest || !run || latest.topic !== `run:${run.id}`) return
    const d = latest.data ?? {}

    if (latest.type === 'run.step' && d.kind === 'llm_call' && d.text) {
      setEntries((e) => [...e, { kind: 'say', text: String(d.text), cost: d.cost_usd }])
    }
    if (latest.type === 'run.step' && d.kind === 'tool_call') {
      setEntries((e) => [...e, {
        kind: 'tool', tool: d.tool_name, status: d.status, step: d.step_no,
        text: String(d.summary ?? ''),
      }])
    }
    if (latest.type === 'run.finished') {
      setEntries((e) => [...e, { kind: 'done', text: String(d.summary ?? '') }])
      void api.run(run.id).then(setRun)
    }
    if (latest.type === 'run.state' && ['failed', 'blocked', 'paused_budget'].includes(d.state)) {
      setEntries((e) => [...e, { kind: 'error', text: `${d.state}${d.reason ? ` — ${d.reason}` : ''}` }])
      void api.run(run.id).then(setRun)
    }
  }, [frames, run?.id])

  const send = async () => {
    const text = goal.trim()
    if (!text || sending) return
    setSending(true)
    setEntries((e) => [...e, { kind: 'goal', text }])
    setGoal('')
    try {
      const r = await api.createRun(
        botId, text,
        domains.split(',').map((s) => s.trim()).filter(Boolean),
        budget ? Number(budget) : undefined,
      )
      setRun(r)
      subscribe([`run:${r.id}`, `bot:${botId}`])
    } catch (e) {
      setEntries((x) => [...x, { kind: 'error', text: String((e as Error).message) }])
    } finally { setSending(false) }
  }

  const live = run && ['queued', 'running'].includes(run.state)

  return (
    <div className="thread">
      <div className="thread-head">
        <div>
          <div className="thread-title">{botId}</div>
          {run && (
            <div className="thread-sub">
              <span className={`pill pill-${run.state}`}>{run.state}</span>
              step {run.step_no}/{run.max_steps} · ${Number(run.spend_usd).toFixed(4)} of ${run.max_usd}
            </div>
          )}
        </div>
        {live && <button className="btn btn-ghost" onClick={() => api.cancel(run!.id)}>Stop</button>}
      </div>

      <div className="messages">
        {entries.length === 0 && (
          <div className="empty">
            <p>Give this bot a job.</p>
            <p className="dim">
              It has its own computer — a browser it stays logged into, a shell, and a desktop.
              It'll use whichever fits.
            </p>
          </div>
        )}
        {entries.map((e, i) => <Bubble key={i} e={e} />)}
        {live && <div className="working"><span className="dot" />working…</div>}
        {run?.state === 'paused_budget' && (
          <div className="bubble capped">
            <b>Paused at its spending cap</b>
            <div className="dim">
              ${Number(run.spend_usd).toFixed(4)} of ${Number(run.max_usd).toFixed(2)} for this run.
              This is a runaway-loop guardrail, not your balance.
            </div>
            <div className="cap-actions">
              {[1, 5, 20].map((n) => (
                <button key={n} className="btn" onClick={async () => {
                  await api.resume(run.id, n)
                  setEntries((e) => [...e, { kind: 'say', text: `— continued with $${n} more —` }])
                  void api.run(run.id).then(setRun)
                }}>Continue +${n}</button>
              ))}
            </div>
          </div>
        )}
        <div ref={endRef} />
      </div>

      <div className="composer">
        <div className="composer-opts">
          <input
            className="domains" value={domains} onChange={(ev) => setDomains(ev.target.value)}
            placeholder="any site — or limit it, e.g. linkedin.com, fec.gov"
            title="Sites this run may visit. Blank means any site. Enforced in the container, not the prompt."
          />
          <input
            className="domains budget" value={budget} onChange={(ev) => setBudget(ev.target.value)}
            placeholder="max $" inputMode="decimal"
            title="Per-run spending cap. Guards against runaway loops; blank uses the daemon default."
          />
        </div>
        <div className="composer-row">
          <textarea
            value={goal} onChange={(ev) => setGoal(ev.target.value)}
            onKeyDown={(ev) => { if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) void send() }}
            placeholder={`Message ${botId}…    (⌘/Ctrl+Enter to send)`} rows={2}
          />
          <button className="btn btn-send" onClick={send} disabled={sending || !goal.trim()}>Send</button>
        </div>
      </div>
    </div>
  )
}

function Bubble({ e }: { e: Entry }) {
  if (e.kind === 'goal') return <div className="bubble you">{e.text}</div>
  if (e.kind === 'say') return <div className="bubble bot">{e.text}</div>
  if (e.kind === 'done') return <div className="bubble done"><b>Done</b><div>{e.text}</div></div>
  if (e.kind === 'error') return <div className="bubble err">{e.text}</div>
  const verb = TOOL_VERB[e.tool ?? ''] ?? e.tool
  return (
    <div className={`step ${e.status === 'error' ? 'step-err' : ''}`}>
      <span className="step-no">{e.step}</span>
      <span className="step-verb">{verb}</span>
      <span className="step-arg">{e.text}</span>
    </div>
  )
}
