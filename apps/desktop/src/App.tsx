import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { api, connect, initToken, subscribe, type Bot, type Frame } from './api.ts'
import { Thread } from './components/Thread.tsx'
import { ComputerPanel } from './components/ComputerPanel.tsx'

export default function App() {
  const [bots, setBots] = useState<Bot[]>([])
  const [active, setActive] = useState<string | null>(null)
  const [frames, setFrames] = useState<Frame[]>([])
  const [conn, setConn] = useState<'up' | 'down'>('down')
  const [boot, setBoot] = useState<string | null>('connecting…')
  const [logs, setLogs] = useState<string | null>(null)

  useEffect(() => {
    void (async () => {
      try {
        await initToken()
        await api.health()
        const list = await api.bots()
        setBots(list)
        setActive((a) => a ?? list[0]?.id ?? null)
        setBoot(null)
      } catch {
        // Debugging a daemon you cannot see is miserable, so say what is wrong
        // and offer to start it rather than showing a dead screen.
        const st = await invoke<{ unit_active: boolean }>('daemon_status').catch(() => ({ unit_active: true }))
        setBoot(st.unit_active
          ? 'The daemon is running but not answering on 127.0.0.1:8787.'
          : 'The daemon is not running. Your bots are not working.')
      }
    })()
  }, [])

  useEffect(() => {
    if (boot) return
    const stop = connect((f) => setFrames((prev) => [...prev.slice(-400), f]), setConn)
    return stop
  }, [boot])

  useEffect(() => { if (active) subscribe([`bot:${active}`]) }, [active])

  if (boot) {
    return (
      <div className="boot">
        <h1>Grokked Bot</h1>
        <p className="boot-msg">{boot}</p>
        <div className="boot-actions">
          <button className="btn" onClick={() => invoke('start_daemon').then(() => location.reload())}>
            Start daemon
          </button>
          <button className="btn btn-ghost" onClick={() => invoke<string>('daemon_logs').then(setLogs)}>
            Show logs
          </button>
        </div>
        {logs && <pre className="logs">{logs}</pre>}
      </div>
    )
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-dot" />
          <span>Grokked</span>
          <span className={`conn conn-${conn}`} title={conn === 'up' ? 'connected' : 'daemon offline'} />
        </div>
        <div className="bots">
          {bots.map((b) => (
            <button key={b.id} className={`bot ${active === b.id ? 'bot-active' : ''}`} onClick={() => setActive(b.id)}>
              <span className="avatar" style={{ background: colorFor(b.id) }}>{b.name.slice(0, 1)}</span>
              <span className="bot-meta">
                <span className="bot-name">{b.name}</span>
                <span className="bot-sub">{b.id}</span>
              </span>
            </button>
          ))}
        </div>
        <button
          className="btn btn-ghost new-bot"
          onClick={async () => {
            const name = prompt('Name this bot')
            if (!name) return
            const b = await api.createBot(name)
            setBots((x) => [...x, b]); setActive(b.id)
          }}
        >+ New bot</button>
        {conn === 'down' && <div className="offline">Daemon offline — your bots are not working.</div>}
      </aside>

      {active
        ? <>
            <Thread botId={active} frames={frames} />
            <ComputerPanel botId={active} />
          </>
        : <div className="thread empty-thread"><p>Create a bot to get started.</p></div>}
    </div>
  )
}

function colorFor(id: string): string {
  let h = 0
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) % 360
  return `hsl(${h} 45% 42%)`
}
