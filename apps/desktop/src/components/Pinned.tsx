import { useEffect, useState } from 'react'
import { api, type Bot, type Pin } from '../api.ts'
import { Avatar } from './Avatar.tsx'
import { copyText } from './Thread.tsx'

/** Every pinned response, newest first, each linked back to its conversation. */
export function Pinned({ bots, onOpen, onClose }: {
  bots: Bot[]
  onOpen: (botId: string, threadId: string) => void
  onClose: () => void
}) {
  const [pins, setPins] = useState<Pin[] | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const botById = new Map(bots.map((b) => [b.id, b]))

  useEffect(() => { void api.pins().then(setPins).catch(() => setPins([])) }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  useEffect(() => { if (!note) return; const t = setTimeout(() => setNote(null), 1500); return () => clearTimeout(t) }, [note])

  const unpin = async (id: string) => {
    await api.unpin(id).catch(() => {})
    setPins((ps) => ps?.filter((p) => p.id !== id) ?? null)
    window.dispatchEvent(new Event('grokked:pins'))
  }

  return (
    <div className="settings-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="pinned">
        <div className="pinned-head">
          <b>📌 Pinned results</b>
          <span className="overlay-note">{note}</span>
          <button className="icon-btn" onClick={onClose} title="Close (Esc)">✕</button>
        </div>
        <div className="pinned-list">
          {pins === null && <p className="dim">Loading…</p>}
          {pins?.length === 0 && (
            <p className="dim">Nothing pinned yet. Pin a bot's answer with 📌 under it to keep it here.</p>
          )}
          {pins?.map((p) => {
            const b = botById.get(p.bot_id)
            const expanded = open === p.id
            return (
              <div key={p.id} className="pin-card">
                <div className="pin-meta">
                  {b && <Avatar bot={b} size={22} />}
                  <span><b>{b?.name ?? p.bot_id}</b>{p.thread_title ? ` · ${p.thread_title}` : ''}</span>
                  <span className="field-hint">{new Date(p.created_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</span>
                </div>
                <div className={`pin-text ${expanded ? 'pin-text-open' : ''}`} onClick={() => setOpen(expanded ? null : p.id)}
                  title={expanded ? 'Click to collapse' : 'Click to read it all'}>{p.text}</div>
                <div className="pin-actions">
                  <button className="copy-btn" onClick={() => copyText(p.text).then(() => setNote('Copied'))}>⧉ Copy</button>
                  {p.thread_id && <button className="copy-btn" onClick={() => { onOpen(p.bot_id, p.thread_id!); onClose() }}>Open conversation</button>}
                  <button className="copy-btn" onClick={() => unpin(p.id)}>Unpin</button>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
