import { useEffect, useState } from 'react'
import { api, type Bot, type BotFile } from '../api.ts'
import { Avatar, look } from './Avatar.tsx'
import { ComputerPanel } from './ComputerPanel.tsx'
import { ModelPicker } from './Settings.tsx'
import { Triggers } from './Triggers.tsx'

type Tab = 'details' | 'triggers' | 'media' | 'computer'

/** The bot itself: who it is, what it has made, and its live computer. */
export function BotPanel({ bot, initialTab = 'computer', onChange, onOpenThread }: {
  bot: Bot
  initialTab?: Tab
  onChange: (b: Bot) => void
  onOpenThread: (threadId: string) => void
}) {
  const [tab, setTab] = useState<Tab>(initialTab)
  const [pendingTakeover, setPendingTakeover] = useState(false)

  // "Take over the screen" from a question in the chat. If the Computer tab is
  // open, its own listener handles it; otherwise open it and take over on mount.
  useEffect(() => {
    const onAsk = () => { if (tab !== 'computer') { setPendingTakeover(true); setTab('computer') } }
    window.addEventListener('grokked:takeover', onAsk)
    return () => window.removeEventListener('grokked:takeover', onAsk)
  }, [tab])

  return (
    <div className="botpanel">
      <div className="profile">
        <Avatar bot={bot} size={64} />
        <div className="profile-name">{bot.name}</div>
        <div className="profile-desc">{bot.description || <span className="dim">No description yet</span>}</div>
        <div className="tabs">
          {(['details', 'triggers', 'media', 'computer'] as const).map((t) => (
            <button key={t} className={`tab ${tab === t ? 'tab-on' : ''}`} onClick={() => setTab(t)}>
              {t[0]!.toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>
      </div>
      <div className="tab-body">
        {tab === 'details' && <Details bot={bot} onChange={onChange} />}
        {tab === 'triggers' && <Triggers bot={bot} onOpenThread={onOpenThread} />}
        {tab === 'media' && <Media bot={bot} />}
        {tab === 'computer' && (
          <ComputerPanel botId={bot.id} name={bot.name}
            autoTakeover={pendingTakeover} onAutoTakeover={() => setPendingTakeover(false)} />
        )}
      </div>
    </div>
  )
}

function Details({ bot, onChange }: { bot: Bot; onChange: (b: Bot) => void }) {
  const [name, setName] = useState(bot.name)
  const [description, setDescription] = useState(bot.description)
  const [persona, setPersona] = useState(bot.persona_md)
  const [domains, setDomains] = useState(bot.default_domains.join(', '))
  const [budget, setBudget] = useState(bot.default_max_usd?.toString() ?? '')
  const [saved, setSaved] = useState<string | null>(null)

  const save = async (patch: Parameters<typeof api.updateBot>[1]) => {
    try {
      onChange(await api.updateBot(bot.id, patch))
      setSaved('Saved')
    } catch (e) { setSaved(`Couldn't save: ${(e as Error).message}`) }
  }
  useEffect(() => { if (!saved) return; const t = setTimeout(() => setSaved(null), 1500); return () => clearTimeout(t) }, [saved])

  const { shape, hue } = look(bot)

  return (
    <div className="details">
      <label>Name
        <input value={name} onChange={(e) => setName(e.target.value)}
          onBlur={() => name.trim() && name !== bot.name && save({ name })} />
      </label>
      <label>What it's for
        <input value={description} placeholder="e.g. Filling job applications"
          onChange={(e) => setDescription(e.target.value)}
          onBlur={() => description !== bot.description && save({ description })} />
      </label>
      <label>Instructions
        <textarea rows={6} value={persona}
          placeholder="How it should work, what it should know about you, what it must never do."
          onChange={(e) => setPersona(e.target.value)}
          onBlur={() => persona !== bot.persona_md && save({ persona_md: persona })} />
      </label>
      <label>Sites it may visit
        <input value={domains} placeholder="any site — or e.g. linkedin.com, indeed.com"
          onChange={(e) => setDomains(e.target.value)}
          onBlur={() => save({ default_domains: domains.split(',').map((s) => s.trim()).filter(Boolean) })} />
        <span className="field-hint">Enforced inside its computer, not just in the prompt. Override per message with + in the chat.</span>
      </label>
      <label>Max $ per message
        <input value={budget} inputMode="decimal" placeholder="daemon default"
          onChange={(e) => setBudget(e.target.value)}
          onBlur={() => save({ default_max_usd: budget.trim() ? Number(budget) : null })} />
      </label>
      <div className="field">
        <span className="field-label">Model</span>
        <ModelPicker value={bot.worker_model} allowDefault="Use the Settings model"
          onChange={(id) => save({ worker_model: id })} />
      </div>
      <div className="look">
        <span className="field-label">Look</span>
        <div className="look-row">
          {[0, 1, 2, 3].map((s) => (
            <button key={s} className={`look-opt ${s === shape ? 'look-on' : ''}`}
              onClick={() => save({ avatar: { shape: s, hue } })}>
              <Avatar bot={{ id: bot.id, avatar: { shape: s, hue } }} size={30} />
            </button>
          ))}
          <input type="range" min={0} max={359} value={hue} className="hue"
            onChange={(e) => onChange({ ...bot, avatar: { shape, hue: Number(e.target.value) } })}
            onMouseUp={(e) => save({ avatar: { shape, hue: Number((e.target as HTMLInputElement).value) } })} />
        </div>
      </div>
      <div className="field-hint">{saved ?? `id ${bot.id}`}</div>
    </div>
  )
}

const IMAGE = /\.(png|jpe?g|gif|webp|svg)$/i
const size = (n: number) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`

function Media({ bot }: { bot: Bot }) {
  const [files, setFiles] = useState<BotFile[] | null>(null)
  const [open, setOpen] = useState<{ f: BotFile; url: string; text?: string } | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const load = () => api.files(bot.id).then((r) => setFiles(r.files)).catch((e) => setErr(String(e.message)))
  useEffect(() => { void load() }, [bot.id])

  const show = async (f: BotFile) => {
    try {
      const url = await api.fileUrl(bot.id, f.path)
      const text = IMAGE.test(f.path) ? undefined
        : f.size < 200_000 ? await (await fetch(url)).text() : undefined
      setOpen({ f, url, text })
    } catch (e) { setErr(String((e as Error).message)) }
  }

  if (open) {
    return (
      <div className="media-view">
        <div className="media-view-head">
          <button className="btn btn-ghost btn-sm" onClick={() => { URL.revokeObjectURL(open.url); setOpen(null) }}>← Back</button>
          <span className="media-name">{open.f.path}</span>
        </div>
        {IMAGE.test(open.f.path)
          ? <img src={open.url} alt={open.f.path} className="media-img" />
          : open.text !== undefined
            ? <pre className="media-text">{open.text}</pre>
            : <p className="dim">Too big to preview here. It's at <code>{open.f.abs}</code></p>}
      </div>
    )
  }

  return (
    <div className="media">
      <div className="media-head">
        <span className="dim">What {bot.name} made or downloaded</span>
        <button className="btn btn-ghost btn-sm" onClick={load}>Refresh</button>
      </div>
      {err && <p className="hint err">{err}</p>}
      {files?.length === 0 && <p className="dim media-empty">Nothing yet. Files it saves or downloads show up here.</p>}
      {files?.map((f) => (
        <button key={f.path} className="file" onClick={() => show(f)} title={f.abs}>
          <span className="file-icon">{IMAGE.test(f.path) ? '▣' : '▤'}</span>
          <span className="file-meta">
            <span className="file-name">{f.path.split('/').pop()}</span>
            <span className="file-sub">{f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) + ' · ' : ''}{size(f.size)} · {new Date(f.mtime).toLocaleString()}</span>
          </span>
        </button>
      ))}
    </div>
  )
}
