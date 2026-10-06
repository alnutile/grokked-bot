import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { api, connect, initToken, subscribe, type Bot, type Frame, type ThreadSummary, type SystemStatus } from './api.ts'
import { Thread } from './components/Thread.tsx'
import { BotPanel } from './components/BotPanel.tsx'
import { Avatar } from './components/Avatar.tsx'
import { Settings } from './components/Settings.tsx'
import { Setup, setupDone } from './components/Setup.tsx'
import { Mascot } from './components/Mascot.tsx'

export default function App() {
  const [bots, setBots] = useState<Bot[]>([])
  const [active, setActive] = useState<string | null>(null)
  // The open conversation; null is a new one that exists once you send to it.
  const [threadId, setThreadId] = useState<string | null>(null)
  // Bumped when you pick a conversation, so the chat remounts for it -- but not
  // when sending creates one, which would throw away the in-flight view.
  const [viewKey, setViewKey] = useState(0)
  const [threads, setThreads] = useState<ThreadSummary[]>([])
  const [panelTab, setPanelTab] = useState<'details' | 'computer'>('computer')
  const [showSettings, setShowSettings] = useState(false)
  const [frames, setFrames] = useState<Frame[]>([])
  const [conn, setConn] = useState<'up' | 'down'>('down')
  const [boot, setBoot] = useState<string | null>('Starting up…')
  const [bootFailed, setBootFailed] = useState(false)
  const [bootAttempt, setBootAttempt] = useState(0)
  const [bootBusy, setBootBusy] = useState(false)
  const [logs, setLogs] = useState<string | null>(null)
  const [credit, setCredit] = useState<number | null>(null)
  const [system, setSystem] = useState<SystemStatus | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      // On a Mac the app starts the daemon itself, so it may still be booting
      // (creating its token, running migrations) on the first try. Keep trying
      // for a bit before calling it broken.
      let last: unknown = null
      for (let i = 0; i < 20 && !cancelled; i++) {
        try {
          await initToken()
          await api.health()
          setSystem(await api.system())
          const [list, convs] = await Promise.all([api.bots(), api.threads()])
          if (cancelled) return
          setBots(list)
          setThreads(convs)
          const first = convs[0]
          setActive(first?.bot_id ?? list[0]?.id ?? null)
          setThreadId(first?.id ?? null)
          setBoot(null)
          return
        } catch (e) {
          last = e
          await new Promise((r) => setTimeout(r, 1000))
        }
      }
      if (cancelled) return
      // Debugging a daemon you cannot see is miserable, so say what is wrong
      // and offer to start it rather than showing a dead screen. Never guess:
      // if even asking the app fails, show that error.
      try {
        const st = await invoke<{ unit_active: boolean; error: string | null }>('daemon_status')
        setBoot(st.error
          ?? (st.unit_active
            ? `The daemon is running but not answering on 127.0.0.1:8787 (${String(last)}).`
            : 'The daemon is not running, so your bots are not working.'))
      } catch (e) {
        setBoot(`The app couldn't check on its daemon: ${String(e)}`)
      }
      setBootFailed(true)
    })()
    return () => { cancelled = true }
  }, [bootAttempt])

  useEffect(() => {
    if (boot) return
    const stop = connect((f) => setFrames((prev) => [...prev.slice(-400), f]), setConn)
    return stop
  }, [boot])

  useEffect(() => { if (bots.length) subscribe(bots.map((b) => `bot:${b.id}`)) }, [bots.length])

  // Keep the conversation list fresh as runs start, finish and get titled.
  const latest = frames[frames.length - 1]
  useEffect(() => {
    if (latest && ['run.created', 'run.finished', 'run.state', 'thread.updated'].includes(latest.type)) {
      void api.threads().then(setThreads).catch(() => {})
    }
  }, [latest?.seq])

  const openBot = (botId: string) => {
    setActive(botId)
    setThreadId(threads.find((t) => t.bot_id === botId)?.id ?? null)
    setViewKey((k) => k + 1)
    setPanelTab('computer')
  }
  const openThread = (t: ThreadSummary) => {
    setActive(t.bot_id)
    setThreadId(t.id)
    setViewKey((k) => k + 1)
  }
  const newBot = async () => {
    const b = await api.createBot('New bot')
    setBots((x) => [...x, b])
    setActive(b.id); setThreadId(null); setViewKey((k) => k + 1)
    setPanelTab('details')
  }
  const bot = bots.find((b) => b.id === active)
  const botById = new Map(bots.map((b) => [b.id, b]))
  useEffect(() => {
    if (boot) return
    const load = () => api.credits().then((c) => setCredit(c.remaining)).catch(() => {})
    void load()
    const t = setInterval(load, 60_000)
    return () => clearInterval(t)
  }, [boot])

  if (boot) {
    const retry = () => { setBoot('Starting up…'); setBootFailed(false); setLogs(null); setBootAttempt((n) => n + 1) }
    return (
      <div className="boot">
        <Mascot size={112} mood={bootFailed ? 'stuck' : 'working'} />
        <h1>Grokked Bot</h1>
        <p className="boot-msg">{boot}</p>
        {bootFailed && (
          <div className="boot-actions">
            <button className="btn" disabled={bootBusy} onClick={async () => {
              setBootBusy(true)
              try { await invoke('start_daemon'); retry() }
              catch (e) { setBoot(`Couldn't start the daemon: ${String(e)}`) }
              finally { setBootBusy(false) }
            }}>
              {bootBusy ? 'Starting…' : 'Start daemon'}
            </button>
            <button className="btn btn-ghost" onClick={() =>
              invoke<string>('daemon_logs').then((l) => setLogs(l.trim() || '(the log is empty)')).catch((e) => setLogs(`Couldn't read the logs: ${String(e)}`))}>
              Show logs
            </button>
          </div>
        )}
        {logs && <pre className="logs">{logs}</pre>}
      </div>
    )
  }

  if (system && !setupDone(system)) return <Setup status={system} onChange={setSystem} />

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-dot" />
          <span>Grokked</span>
          <span className={`conn conn-${conn}`} title={conn === 'up' ? 'connected' : 'daemon offline'} />
          <button className="icon-btn new-bot" onClick={newBot} title="New bot">+</button>
        </div>

        <div className="bot-grid">
          {bots.map((b) => (
            <button key={b.id} className={`tile ${active === b.id ? 'tile-on' : ''}`} onClick={() => openBot(b.id)}
              title={b.description || b.name}>
              <Avatar bot={b} size={46} />
              <span className="tile-name">{b.name}</span>
            </button>
          ))}
        </div>

        <div className="conv-list">
          {threads.length === 0 && <p className="dim conv-empty">Conversations show up here.</p>}
          {threads.map((t) => {
            const b = botById.get(t.bot_id)
            if (!b) return null
            return (
              <button key={t.id} className={`conv ${threadId === t.id ? 'conv-on' : ''}`} onClick={() => openThread(t)}>
                <Avatar bot={b} size={30} />
                <span className="conv-text">{t.preview ?? t.title ?? ''}</span>
                {['running', 'queued'].includes(t.state ?? '') && <span className="dot" title="working" />}
                {t.state === 'blocked' && <span className="conv-flag" title="needs you">!</span>}
              </button>
            )
          })}
        </div>

        <div className="sidebar-foot">
          <button className="settings-btn" onClick={() => setShowSettings(true)} title="Settings: budgets, models, passwords">
            <span className="gear">⚙</span> Settings
          </button>
          {credit !== null && (
            <span className={`credit ${credit < 5 ? 'credit-low' : ''}`} title="Remaining OpenRouter credit">
              ${credit.toFixed(2)} left
            </span>
          )}
        </div>
        {conn === 'down' && <div className="offline">Daemon offline — your bots are not working.</div>}
      </aside>

      {bot
        ? <>
            <Thread key={`${bot.id}:${viewKey}`} bot={bot} threadId={threadId} frames={frames}
              onThreadCreated={(id) => { setThreadId(id); void api.threads().then(setThreads) }}
              onNewConversation={() => { setThreadId(null); setViewKey((k) => k + 1) }} />
            <BotPanel key={bot.id} bot={bot} initialTab={panelTab}
              onChange={(nb) => setBots((list) => list.map((x) => (x.id === nb.id ? nb : x)))} />
          </>
        : <div className="thread empty-thread"><p>Create a bot with + to get started.</p></div>}
      {showSettings && <Settings bots={bots} onClose={() => setShowSettings(false)} />}
    </div>
  )
}
