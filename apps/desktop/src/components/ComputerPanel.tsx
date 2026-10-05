import { useEffect, useState } from 'react'
import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager'
import { api } from '../api.ts'

// noVNC 1.3 inside a cross-origin iframe can't reach the host clipboard, so the
// app moves text across itself: host clipboard here, the bot's X clipboard via
// the daemon. The navigator fallback is for running the UI in a plain browser.
const hostRead = () => readText().catch(() => navigator.clipboard.readText())
const hostWrite = (t: string) => writeText(t).catch(() => navigator.clipboard.writeText(t))

/**
 * The bot's screen, live. Watching is view_only; taking over flips that AND
 * claims a lease on the daemon so the agent stops acting -- otherwise both drive
 * the same X server and fight over the cursor. Taking over also opens the screen
 * big, since the side panel is too small to actually use.
 */
export function ComputerPanel({ botId }: { botId: string }) {
  const [port, setPort] = useState<number | null>(null)
  const [pw, setPw] = useState<string | null>(null)
  const [mine, setMine] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const refresh = () =>
    api.computer(botId)
      .then((c) => { setPort(c.vnc_port); setPw(c.vnc_password); setMine(c.human_in_control); setErr(null) })
      .catch((e) => setErr(String(e.message ?? e)))

  useEffect(() => { void refresh(); const t = setInterval(refresh, 5000); return () => clearInterval(t) }, [botId])
  useEffect(() => { setExpanded(false) }, [botId])
  useEffect(() => { if (!note) return; const t = setTimeout(() => setNote(null), 2500); return () => clearTimeout(t) }, [note])

  const big = mine || expanded
  useEffect(() => {
    if (!big) return
    const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape' && !mine) setExpanded(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [big, mine])

  const toggle = async () => {
    setBusy(true)
    try {
      if (mine) { await api.release(botId); setMine(false); setExpanded(false) }
      else { await api.takeover(botId); setMine(true) }
    } catch (e) { setErr(String((e as Error).message)) } finally { setBusy(false) }
  }

  // "Take over the screen" on a bot's question in the chat.
  useEffect(() => {
    const onAsk = () => { if (!mine) void toggle() }
    window.addEventListener('grokked:takeover', onAsk)
    return () => window.removeEventListener('grokked:takeover', onAsk)
  })

  const pasteIn = async () => {
    try {
      const text = await hostRead()
      if (!text) { setNote('Your clipboard is empty'); return }
      await api.setBotClipboard(botId, text, true)
      setNote('Pasted into the bot')
    } catch (e) { setErr(`paste failed: ${(e as Error).message}`) }
  }

  const copyOut = async () => {
    try {
      const text = await api.botClipboard(botId)
      if (!text) { setNote("The bot's clipboard is empty"); return }
      await hostWrite(text)
      setNote(`Copied ${text.length} characters to your clipboard`)
    } catch (e) { setErr(`copy failed: ${(e as Error).message}`) }
  }

  const src = port
    ? `http://127.0.0.1:${port}/vnc.html?autoconnect=1&reconnect=1&resize=scale` +
      `&view_only=${mine ? 0 : 1}${pw ? `&password=${encodeURIComponent(pw)}` : ''}`
    : null

  const screen = (
    <div className={`screen ${mine ? 'screen-live' : ''}`}>
      {src
        ? <iframe key={src} src={src} title="bot screen" allow="clipboard-read; clipboard-write" />
        : <div className="screen-empty">{err ? 'computer unreachable' : 'starting…'}</div>}
    </div>
  )

  return (
    <div className="computer">
      <div className="computer-head">
        <span className="label">{botId}'s screen</span>
        {mine && <span className="pill pill-live">you have control</span>}
        {!big && src && (
          <button className="icon-btn" onClick={() => setExpanded(true)} title="Open full size">⤢</button>
        )}
      </div>

      {big
        ? <div className="screen screen-placeholder"><div className="screen-empty">open full size</div></div>
        : screen}

      <div className="computer-actions">
        <button className={mine ? 'btn btn-warn' : 'btn'} onClick={toggle} disabled={busy || !port}>
          {mine ? 'Give control back' : 'Take over'}
        </button>
        <button className="btn btn-ghost" onClick={() => api.startComputer(botId).then(refresh)}>
          Restart computer
        </button>
      </div>
      {err && <p className="hint err">{err}</p>}

      {big && (
        <div className="screen-overlay">
          <div className="overlay-bar">
            <span className="label">{botId}'s screen</span>
            {mine
              ? <span className="pill pill-live">you have control — the bot is paused</span>
              : <span className="pill">watching</span>}
            <span className="overlay-note">{note}</span>
            <div className="overlay-actions">
              {mine && <>
                <button className="btn btn-ghost" onClick={pasteIn}
                  title="Put your clipboard into the bot's and paste it where the cursor is">
                  Paste from my PC
                </button>
                <button className="btn btn-ghost" onClick={copyOut}
                  title="Copy whatever the bot last copied (Ctrl+C on its screen) to your clipboard">
                  Copy to my PC
                </button>
              </>}
              <button className={mine ? 'btn btn-warn' : 'btn'} onClick={toggle} disabled={busy}>
                {mine ? 'Give control back' : 'Take over'}
              </button>
              {!mine && <button className="btn btn-ghost" onClick={() => setExpanded(false)}>Close</button>}
            </div>
          </div>
          <div className="overlay-stage">{screen}</div>
          {err && <p className="hint err">{err}</p>}
        </div>
      )}
    </div>
  )
}
