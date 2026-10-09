import { useEffect, useState } from 'react'
import { openPath, revealItemInDir } from '@tauri-apps/plugin-opener'
import { api, type Bot, type BotEnv, type BotFile } from '../api.ts'
import { Avatar, look } from './Avatar.tsx'
import { ComputerPanel } from './ComputerPanel.tsx'
import { ModelPicker } from './Settings.tsx'
import { Triggers } from './Triggers.tsx'

type Tab = 'details' | 'env' | 'triggers' | 'media' | 'computer'
const TAB_LABEL: Record<Tab, string> = { details: 'Details', env: 'Env', triggers: 'Triggers', media: 'Media', computer: 'Computer' }

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
          {(['details', 'env', 'triggers', 'media', 'computer'] as const).map((t) => (
            <button key={t} className={`tab ${tab === t ? 'tab-on' : ''}`} onClick={() => setTab(t)}
              title={t === 'env' ? 'Environment variables' : undefined}>
              {TAB_LABEL[t]}
            </button>
          ))}
        </div>
      </div>
      <div className="tab-body">
        {tab === 'details' && <Details bot={bot} onChange={onChange} />}
        {tab === 'env' && <Env bot={bot} />}
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
  const [steps, setSteps] = useState(bot.default_max_steps?.toString() ?? '')
  const [minutes, setMinutes] = useState(bot.default_max_wall_s ? String(bot.default_max_wall_s / 60) : '')
  // Blank means "use Settings"; anything else must be a positive number.
  const num = (v: string) => (v.trim() && Number(v) > 0 ? Number(v) : null)
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
      <div className="field-row">
        <label>Max steps per message
          <input value={steps} inputMode="numeric" placeholder="Settings default"
            onChange={(e) => setSteps(e.target.value)}
            onBlur={() => save({ default_max_steps: num(steps) })} />
        </label>
        <label>Max minutes per message
          <input value={minutes} inputMode="numeric" placeholder="Settings default"
            onChange={(e) => setMinutes(e.target.value)}
            onBlur={() => { const m = num(minutes); save({ default_max_wall_s: m === null ? null : Math.round(m * 60) }) }} />
        </label>
      </div>
      <span className="field-hint">Give a coding bot room (300 steps, 180 minutes); keep a shopping bot tight. Blank uses Settings.</span>
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

/** Its shell's environment variables, pasted in as a .env file. */
function Env({ bot }: { bot: Bot }) {
  const [env, setEnv] = useState<BotEnv | null>(null)
  const [draft, setDraft] = useState<string | null>(null)
  const [shown, setShown] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    setEnv(null); setDraft(null); setShown(false)
    api.env(bot.id).then((e) => { setEnv(e); if (!e.vars.length) setDraft('') }).catch((e) => setErr(String(e.message)))
  }, [bot.id])

  const save = async () => {
    if (draft === null) return
    try {
      const e = await api.saveEnv(bot.id, draft)
      setEnv(e); setDraft(e.vars.length ? null : ''); setErr(null)
      setNote(e.skipped.length ? `Saved. Skipped: ${e.skipped.join(', ')}` : `Saved ${e.vars.length} variable${e.vars.length === 1 ? '' : 's'}`)
    } catch (e) { setErr(`Couldn't save: ${(e as Error).message}`) }
  }

  if (!env) return <div className="details">{err ? <p className="hint err">{err}</p> : <p className="dim">Loading…</p>}</div>
  const github = env.vars.some((v) => v.key === 'GITHUB_TOKEN' || v.key === 'GH_TOKEN')

  return (
    <div className="details">
      <span className="field-hint">
        Every command {bot.name} runs in its shell gets these. It's told their names, never their values, and
        secret-looking values are masked in what it sees. Stored encrypted, like saved passwords.
      </span>
      {draft !== null ? (
        <>
          <label>.env
            <textarea rows={12} value={draft} spellCheck={false} className="env-text"
              placeholder={'# Paste a .env file\nGITHUB_TOKEN=github_pat_...\nAPI_BASE_URL=https://api.example.com'}
              onChange={(e) => setDraft(e.target.value)} />
          </label>
          <div className="row-gap">
            <button className="btn btn-sm" onClick={save}>Save</button>
            {env.vars.length > 0 && <button className="btn btn-ghost btn-sm" onClick={() => setDraft(null)}>Cancel</button>}
          </div>
          {env.vars.length > 0 && <span className="field-hint">Saving replaces the whole set. Delete a line to remove that variable.</span>}
        </>
      ) : (
        <>
          <div className="env-list">
            {env.vars.map((v) => (
              <div key={v.key} className="env-row">
                <code className="env-key">{v.key}</code>
                <code className="env-val">{v.secret && !shown ? '••••••••' : v.value || <span className="dim">(empty)</span>}</code>
              </div>
            ))}
          </div>
          <div className="row-gap">
            <button className="btn btn-sm" onClick={() => setDraft(env.text)}>Edit</button>
            <button className="btn btn-ghost btn-sm" onClick={() => setShown((s) => !s)}>{shown ? 'Hide values' : 'Show values'}</button>
          </div>
        </>
      )}
      <span className="field-hint">
        {github
          ? 'GitHub: git clone over https and the gh CLI use this token, so it can work on private repos. Give the token only the repos and permissions this bot needs.'
          : 'To let it clone and work on GitHub repos, add GITHUB_TOKEN: a fine-grained token limited to the repos it needs.'}
      </span>
      {err && <p className="hint err">{err}</p>}
      {note && <span className="field-hint">{note}</span>}
    </div>
  )
}

const IMAGE = /\.(png|jpe?g|gif|webp|svg)$/i
const size = (n: number) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`

function Media({ bot }: { bot: Bot }) {
  const [files, setFiles] = useState<BotFile[] | null>(null)
  const [root, setRoot] = useState<string | null>(null)
  const [open, setOpen] = useState<{ f: BotFile; url: string; text?: string } | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const load = () => api.files(bot.id).then((r) => { setFiles(r.files); setRoot(r.root) }).catch((e) => setErr(String(e.message)))
  // Hand the file to the desktop: your default app, or the file manager.
  const desktop = (fn: () => Promise<unknown>) => fn().catch((e) => setErr(`Couldn't open it: ${String((e as Error)?.message ?? e)}`))
  useEffect(() => { void load() }, [bot.id])

  const show = async (f: BotFile) => {
    try {
      if (IMAGE.test(f.path)) setOpen({ f, url: await api.fileUrl(bot.id, f.path) })
      else setOpen({ f, url: '', text: f.size < 200_000 ? await api.fileText(bot.id, f.path) : undefined })
    } catch (e) { setErr(String((e as Error).message)) }
  }

  if (open) {
    return (
      <div className="media-view">
        <div className="media-view-head">
          <button className="btn btn-ghost btn-sm" onClick={() => { if (open.url) URL.revokeObjectURL(open.url); setOpen(null) }}>← Back</button>
          <span className="media-name">{open.f.path}</span>
          <button className="btn btn-ghost btn-sm" onClick={() => desktop(() => openPath(open.f.abs))}>Open</button>
          <button className="btn btn-ghost btn-sm" onClick={() => desktop(() => revealItemInDir(open.f.abs))}>Show in folder</button>
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
        <span className="row-gap">
          {root && <button className="btn btn-ghost btn-sm" onClick={() => desktop(() => openPath(root))}
            title={root}>Open folder</button>}
          <button className="btn btn-ghost btn-sm" onClick={load}>Refresh</button>
        </span>
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
