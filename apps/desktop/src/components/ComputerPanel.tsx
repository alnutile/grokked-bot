import { useEffect, useState } from 'react'
import { api } from '../api.ts'

/**
 * The bot's screen, live. Watching is view_only; taking over flips that AND
 * claims a lease on the daemon so the agent stops acting -- otherwise both drive
 * the same X server and fight over the cursor.
 */
export function ComputerPanel({ botId }: { botId: string }) {
  const [port, setPort] = useState<number | null>(null)
  const [pw, setPw] = useState<string | null>(null)
  const [mine, setMine] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const refresh = () =>
    api.computer(botId)
      .then((c) => { setPort(c.vnc_port); setPw(c.vnc_password); setMine(c.human_in_control); setErr(null) })
      .catch((e) => setErr(String(e.message ?? e)))

  useEffect(() => { void refresh(); const t = setInterval(refresh, 5000); return () => clearInterval(t) }, [botId])

  const toggle = async () => {
    setBusy(true)
    try {
      if (mine) { await api.release(botId); setMine(false) }
      else { await api.takeover(botId); setMine(true) }
    } catch (e) { setErr(String((e as Error).message)) } finally { setBusy(false) }
  }

  const src = port
    ? `http://127.0.0.1:${port}/vnc.html?autoconnect=1&reconnect=1&resize=scale` +
      `&view_only=${mine ? 0 : 1}${pw ? `&password=${encodeURIComponent(pw)}` : ''}`
    : null

  return (
    <div className="computer">
      <div className="computer-head">
        <span className="label">{botId}'s screen</span>
        {mine && <span className="pill pill-live">you have control</span>}
      </div>

      <div className={`screen ${mine ? 'screen-live' : ''}`}>
        {src
          ? <iframe key={`${src}`} src={src} title="bot screen" allow="clipboard-read; clipboard-write" />
          : <div className="screen-empty">{err ? 'computer unreachable' : 'starting…'}</div>}
      </div>

      <div className="computer-actions">
        <button className={mine ? 'btn btn-warn' : 'btn'} onClick={toggle} disabled={busy || !port}>
          {mine ? 'Give control back' : 'Take over'}
        </button>
        <button className="btn btn-ghost" onClick={() => api.startComputer(botId).then(refresh)}>
          Restart computer
        </button>
      </div>
      {mine && <p className="hint">The bot is paused. Click into the screen and drive it yourself.</p>}
      {err && <p className="hint err">{err}</p>}
    </div>
  )
}
