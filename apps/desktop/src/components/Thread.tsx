import { useEffect, useRef, useState } from 'react'
import { api, subscribe, type Bot, type Frame, type Run } from '../api.ts'
import { Avatar } from './Avatar.tsx'

export interface Entry {
  kind: 'goal' | 'say' | 'tool' | 'done' | 'ask' | 'error'
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
  credentials_list: 'checked saved logins', browser_fill_credential: 'filled in a saved login:',
}

/**
 * One conversation with a bot. `threadId` null means a new conversation that
 * doesn't exist until the first message; `onThreadCreated` reports its id.
 */
export function Thread({ bot, threadId, frames, onThreadCreated, onNewConversation }: {
  bot: Bot
  threadId: string | null
  frames: Frame[]
  onThreadCreated: (id: string) => void
  onNewConversation: () => void
}) {
  const [tid, setTid] = useState(threadId)
  const [title, setTitle] = useState('')
  const [entries, setEntries] = useState<Entry[]>([])
  const [run, setRun] = useState<Run | null>(null)
  const [goal, setGoal] = useState('')
  const [showOpts, setShowOpts] = useState(false)
  const [domains, setDomains] = useState('')   // blank = the bot's defaults
  const [budget, setBudget] = useState('')
  const [sending, setSending] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  // Frames already reflected in `entries`; a loaded transcript covers everything so far.
  const seenSeq = useRef(0)
  const lastSeq = () => frames.length ? frames[frames.length - 1]!.seq : 0

  // Scroll only the message list. scrollIntoView also scrolls every ancestor,
  // which dragged the whole window down and hid the sidebar and screen.
  useEffect(() => {
    const list = listRef.current
    list?.scrollTo({ top: list.scrollHeight, behavior: 'smooth' })
  }, [entries.length])

  // The conversation lives in the daemon, so it survives restarts and switches.
  useEffect(() => {
    if (!threadId) return
    void api.threadById(threadId).then((t) => {
      seenSeq.current = lastSeq()
      setTitle(t.thread.title ?? '')
      setEntries(t.entries)
      setRun(t.run)
      if (t.run) subscribe([`run:${t.run.id}`])
    }).catch(() => {})
  }, [threadId])

  // Automatic titles arrive a moment after the first message.
  useEffect(() => {
    const f = frames[frames.length - 1]
    if (f?.type === 'thread.updated' && f.data?.thread_id === tid && f.data?.title) setTitle(String(f.data.title))
  }, [frames, tid])

  // Poll the run row while it is live. The WS carries step events, but state,
  // step count and spend live on the run itself.
  useEffect(() => {
    if (!run || !['queued', 'running'].includes(run.state)) return
    const t = setInterval(() => { void api.run(run.id).then(setRun).catch(() => {}) }, 1500)
    return () => clearInterval(t)
  }, [run?.id, run?.state])

  // Several frames can land in one render, so walk everything new rather than
  // only the latest.
  useEffect(() => {
    if (!run) return
    const fresh = frames.filter((f) => f.seq > seenSeq.current && f.topic === `run:${run.id}`)
    if (frames.length) seenSeq.current = Math.max(seenSeq.current, frames[frames.length - 1]!.seq)
    for (const f of fresh) {
      const d = f.data ?? {}
      if (f.type === 'run.step' && d.kind === 'llm_call' && d.text) {
        setEntries((e) => [...e, { kind: 'say', text: String(d.text), cost: d.cost_usd }])
      }
      if (f.type === 'run.step' && d.kind === 'tool_call') {
        setEntries((e) => [...e, {
          kind: 'tool', tool: d.tool_name, status: d.status, step: d.step_no, text: String(d.summary ?? ''),
        }])
      }
      if (f.type === 'run.finished') setEntries((e) => [...e, { kind: 'done', text: String(d.summary ?? '') }])
      if (f.type === 'run.state' && d.state === 'blocked' && d.question) {
        setEntries((e) => [...e, { kind: 'ask', text: String(d.question) }])
      } else if (f.type === 'run.state' && ['failed', 'blocked'].includes(d.state)) {
        setEntries((e) => [...e, { kind: 'error', text: `${d.state}${d.reason ? ` — ${d.reason}` : ''}` }])
      }
      // Any state change (including a wake-up after you give control back) refreshes the header.
      if (f.type === 'run.state' || f.type === 'run.finished') void api.run(run.id).then(setRun)
    }
  }, [frames, run?.id])

  const send = async () => {
    const text = goal.trim()
    if (!text || sending) return
    setSending(true)
    setEntries((e) => [...e, { kind: 'goal', text }])
    setGoal('')
    try {
      const override = domains.split(',').map((s) => s.trim()).filter(Boolean)
      const r = await api.createRun(bot.id, text, {
        thread_id: tid,
        ...(override.length ? { allowed_domains: override } : {}),
        ...(budget ? { max_usd: Number(budget) } : {}),
      })
      seenSeq.current = lastSeq()
      setRun(r)
      subscribe([`run:${r.id}`])
      if (!tid) { setTid(r.thread_id); onThreadCreated(r.thread_id) }
    } catch (e) {
      setEntries((x) => [...x, { kind: 'error', text: String((e as Error).message) }])
    } finally { setSending(false) }
  }

  const saveTitle = () => { if (tid && title.trim()) void api.renameThread(tid, title.trim()) }

  const live = run && ['queued', 'running'].includes(run.state)
  const waiting = run && (run.state === 'sleeping' || (run.state === 'blocked' && run.state_reason === 'ask_human'))
  const defaults = bot.default_domains.length ? bot.default_domains.join(', ') : 'any site'

  return (
    <div className="thread">
      <div className="thread-head">
        <span className="bot-pill"><Avatar bot={bot} size={20} />{bot.name}</span>
        <input
          className="title-input" value={title} placeholder={tid ? 'Untitled' : 'New conversation'}
          disabled={!tid} onChange={(e) => setTitle(e.target.value)} onBlur={saveTitle}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
          title="Click to rename this conversation"
        />
        <div className="thread-head-right">
          {run && (
            <span className="thread-sub">
              <span className={`pill pill-${run.state}`}>{run.state}</span>
              ${Number(run.spend_usd).toFixed(3)}
            </span>
          )}
          {live
            ? <button className="btn btn-ghost btn-sm" onClick={() => api.cancel(run!.id)}>Stop</button>
            : tid && (
                <button className="btn btn-ghost btn-sm" onClick={onNewConversation}
                  title="Start fresh: the bot won't see this conversation">New</button>
              )}
        </div>
      </div>

      <div className="messages" ref={listRef}>
        {entries.length === 0 && (
          <div className="empty">
            <Avatar bot={bot} size={56} />
            <p>Give {bot.name} a job.</p>
            <p className="dim">
              {bot.description || 'It has its own computer — a browser it stays logged into, a shell, and a desktop. It’ll use whichever fits.'}
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
      </div>

      <div className="composer">
        {showOpts && (
          <div className="composer-opts">
            <label>
              <span>Sites for this message</span>
              <input className="domains" value={domains} onChange={(ev) => setDomains(ev.target.value)}
                placeholder={`${defaults} (bot default)`}
                title="Overrides the bot's default sites. Blank uses the default. Enforced in the container, not the prompt." />
            </label>
            <label className="budget-label">
              <span>Max $</span>
              <input className="domains budget" value={budget} onChange={(ev) => setBudget(ev.target.value)}
                placeholder={bot.default_max_usd ? String(bot.default_max_usd) : 'default'} inputMode="decimal"
                title="Per-run spending cap. Guards against runaway loops." />
            </label>
          </div>
        )}
        <div className="composer-bar">
          <button className={`plus ${showOpts || domains || budget ? 'plus-on' : ''}`} onClick={() => setShowOpts((v) => !v)}
            title="Sites and budget for this message">+</button>
          <textarea
            value={goal} onChange={(ev) => setGoal(ev.target.value)}
            onKeyDown={(ev) => { if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) void send() }}
            placeholder={waiting ? `Reply to ${bot.name}…` : `Message ${bot.name}…`} rows={1}
          />
          <button className="send" onClick={send} disabled={sending || !!live || !goal.trim()}
            title="Send (Ctrl+Enter)">↑</button>
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
  if (e.kind === 'ask') {
    return (
      <div className="bubble ask">
        <b>Needs you</b>
        <div>{e.text}</div>
        <div className="ask-actions">
          <span className="dim">Reply below, or</span>
          <button className="btn btn-warn" onClick={() => window.dispatchEvent(new Event('grokked:takeover'))}>
            Take over the screen
          </button>
        </div>
      </div>
    )
  }
  const verb = TOOL_VERB[e.tool ?? ''] ?? e.tool
  return (
    <div className={`step ${e.status === 'error' ? 'step-err' : ''}`}>
      <span className="step-no">{e.step}</span>
      <span className="step-verb">{verb}</span>
      <span className="step-arg">{e.text}</span>
    </div>
  )
}
