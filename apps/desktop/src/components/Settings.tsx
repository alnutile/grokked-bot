import { useEffect, useMemo, useState } from 'react'
import { api, type Bot, type Credential, type CredentialInput, type ModelInfo, type Settings as SettingsT } from '../api.ts'
import { Avatar } from './Avatar.tsx'

type Section = 'general' | 'models' | 'passwords'

/** Everything that isn't one bot: spending defaults, models, and saved logins. */
export function Settings({ bots, onClose }: { bots: Bot[]; onClose: () => void }) {
  const [section, setSection] = useState<Section>('general')
  const [settings, setSettings] = useState<SettingsT | null>(null)
  const [note, setNote] = useState<string | null>(null)

  useEffect(() => { void api.settings().then(setSettings).catch((e) => setNote(String(e.message))) }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  useEffect(() => { if (!note) return; const t = setTimeout(() => setNote(null), 2000); return () => clearTimeout(t) }, [note])

  const save = async (patch: Parameters<typeof api.saveSettings>[0]) => {
    try { setSettings(await api.saveSettings(patch)); setNote('Saved') }
    catch (e) { setNote(`Couldn't save: ${(e as Error).message}`) }
  }

  return (
    <div className="settings-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="settings">
        <nav className="settings-nav">
          <div className="settings-title">Settings</div>
          {([['general', 'General'], ['models', 'Models'], ['passwords', 'Passwords']] as const).map(([k, label]) => (
            <button key={k} className={`settings-tab ${section === k ? 'settings-tab-on' : ''}`} onClick={() => setSection(k)}>
              {label}
            </button>
          ))}
          <span className="settings-note">{note}</span>
        </nav>
        <div className="settings-body">
          <button className="icon-btn settings-close" onClick={onClose} title="Close (Esc)">✕</button>
          {!settings && section !== 'passwords' && <p className="dim">Loading…</p>}
          {settings && section === 'general' && <General s={settings} save={save} />}
          {settings && section === 'models' && <Models s={settings} save={save} />}
          {section === 'passwords' && <Passwords bots={bots} />}
        </div>
      </div>
    </div>
  )
}

function NumberField({ label, hint, value, onSave, scale = 1 }: {
  label: string; hint: string; value: number; onSave: (v: number) => void; scale?: number
}) {
  const [v, setV] = useState(String(value / scale))
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <input value={v} inputMode="decimal" onChange={(e) => setV(e.target.value)}
        onBlur={() => { const n = Number(v); if (n > 0 && n * scale !== value) onSave(n * scale) }} />
      <span className="field-hint">{hint}</span>
    </label>
  )
}

function General({ s, save }: { s: SettingsT; save: (p: Parameters<typeof api.saveSettings>[0]) => void }) {
  return (
    <div className="settings-section">
      <h2>Spending and limits</h2>
      <p className="dim">Defaults for every message. A bot's Details can set its own budget; the + in the message bar overrides one message.</p>
      <NumberField label="Max $ per message" value={s.defaults.max_usd}
        hint="A runaway-loop guardrail. When a run hits it, it pauses and you can continue with more."
        onSave={(n) => save({ defaults: { max_usd: n } })} />
      <NumberField label="Max steps per message" value={s.defaults.max_steps}
        hint="Each step is one model call and usually one action." onSave={(n) => save({ defaults: { max_steps: Math.round(n) } })} />
      <NumberField label="Max minutes per message" value={s.defaults.max_wall_s} scale={60}
        hint="Wall-clock time, including time spent waiting on you." onSave={(n) => save({ defaults: { max_wall_s: Math.round(n) } })} />
      <NumberField label="Max screenshots per message" value={s.defaults.max_screenshots}
        hint="Screenshots are the expensive way to look at a page; the bot reads pages as text first."
        onSave={(n) => save({ defaults: { max_screenshots: Math.round(n) } })} />
    </div>
  )
}

const price = (m?: ModelInfo) => m ? `$${m.prompt_per_m.toFixed(2)} in · $${m.completion_per_m.toFixed(2)} out per 1M tokens` : ''

/** Searchable picker over OpenRouter's tool-capable models. */
export function ModelPicker({ value, onChange, allowDefault }: {
  value: string; onChange: (id: string) => void; allowDefault?: string
}) {
  const [models, setModels] = useState<ModelInfo[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  useEffect(() => { void api.models().then(setModels).catch((e) => setErr(String(e.message))) }, [])
  const current = models?.find((m) => m.id === value)
  const matches = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean)
    return (models ?? []).filter((m) => words.every((w) => `${m.id} ${m.name}`.toLowerCase().includes(w))).slice(0, 40)
  }, [models, q])

  return (
    <div className="model-picker">
      <button className="model-current" onClick={() => setOpen((o) => !o)}>
        <span className="model-id">{value || allowDefault || 'choose a model'}</span>
        <span className="field-hint">{value ? price(current) || (models && !current ? 'not found on OpenRouter' : '') : 'uses the Settings model'}</span>
      </button>
      {open && (
        <div className="model-menu">
          <input autoFocus placeholder="Search, e.g. sonnet, gemini flash, gpt" value={q} onChange={(e) => setQ(e.target.value)} />
          {err && <p className="hint err">{err}</p>}
          <div className="model-list">
            {allowDefault && (
              <button className="model-opt" onClick={() => { onChange(''); setOpen(false) }}>
                <span className="model-id">{allowDefault}</span>
              </button>
            )}
            {matches.map((m) => (
              <button key={m.id} className={`model-opt ${m.id === value ? 'model-opt-on' : ''}`}
                onClick={() => { onChange(m.id); setOpen(false); setQ('') }}>
                <span className="model-id">{m.id}</span>
                <span className="field-hint">{price(m)} · {Math.round(m.context_length / 1000)}k context</span>
              </button>
            ))}
            {models && matches.length === 0 && <p className="dim">No tool-capable model matches.</p>}
          </div>
        </div>
      )}
    </div>
  )
}

function Models({ s, save }: { s: SettingsT; save: (p: Parameters<typeof api.saveSettings>[0]) => void }) {
  return (
    <div className="settings-section">
      <h2>Models</h2>
      <p className="dim">
        Any OpenRouter model that can call tools. Changes apply from the bot's next step. A bot can use a different
        worker model — set it in that bot's Details.
      </p>
      <div className="field">
        <span className="field-label">Worker — does the tasks</span>
        <ModelPicker value={s.models.worker} onChange={(id) => save({ models: { worker: id } })} />
        <span className="field-hint">The one that matters: it reads pages, decides, and acts. Strong models are worth it here.</span>
      </div>
      <div className="field">
        <span className="field-label">Titles — names conversations</span>
        <ModelPicker value={s.models.classifier} onChange={(id) => save({ models: { classifier: id } })} />
        <span className="field-hint">A short call per conversation. The cheapest fast model is fine.</span>
      </div>
    </div>
  )
}

function Passwords({ bots }: { bots: Bot[] }) {
  const [list, setList] = useState<Credential[] | null>(null)
  const [editing, setEditing] = useState<Credential | 'new' | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const load = () => api.credentials().then(setList).catch((e) => setErr(String(e.message)))
  useEffect(() => { void load() }, [])
  const botName = (id: string) => bots.find((b) => b.id === id)?.name ?? id

  if (editing) {
    return <CredentialForm cred={editing === 'new' ? null : editing} bots={bots}
      onDone={() => { setEditing(null); void load() }} />
  }

  return (
    <div className="settings-section">
      <div className="section-head">
        <h2>Passwords</h2>
        <button className="btn btn-sm" onClick={() => setEditing('new')}>Add login</button>
      </div>
      <p className="dim">
        Logins your bots can use. Passwords are encrypted on this machine and typed into the page by the daemon —
        the AI model never sees them, and they're only ever typed on their own site.
      </p>
      {err && <p className="hint err">{err}</p>}
      {list?.length === 0 && <p className="dim empty-note">No saved logins yet.</p>}
      {list?.map((c) => (
        <button key={c.id} className="cred" onClick={() => setEditing(c)}>
          <span className="cred-icon">{c.label.slice(0, 1).toUpperCase()}</span>
          <span className="cred-meta">
            <span className="cred-label">{c.label}</span>
            <span className="field-hint">{c.domain}{c.username ? ` · ${c.username}` : ''}{c.has_secret ? '' : ' · no password'}</span>
          </span>
          <span className="cred-bots">{c.bot_ids.length ? c.bot_ids.map(botName).join(', ') : 'All bots'}</span>
        </button>
      ))}
    </div>
  )
}

function CredentialForm({ cred, bots, onDone }: { cred: Credential | null; bots: Bot[]; onDone: () => void }) {
  const [label, setLabel] = useState(cred?.label ?? '')
  const [url, setUrl] = useState(cred?.url || cred?.domain || '')
  const [username, setUsername] = useState(cred?.username ?? '')
  const [password, setPassword] = useState('')
  const [shown, setShown] = useState(false)
  const [notes, setNotes] = useState(cred?.notes ?? '')
  const [botIds, setBotIds] = useState<string[]>(cred?.bot_ids ?? [])
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const reveal = async () => {
    if (shown) { setShown(false); return }
    if (cred && !password) setPassword(await api.revealCredential(cred.id).catch(() => ''))
    setShown(true)
  }
  const toggleBot = (id: string) => setBotIds((ids) => ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id])

  const submit = async () => {
    if (!url.trim()) { setErr('Which site is this for?'); return }
    const body: CredentialInput = { label, url, username, notes, bot_ids: botIds }
    if (password || !cred) body.password = password
    try {
      if (cred) await api.updateCredential(cred.id, body)
      else await api.createCredential(body)
      onDone()
    } catch (e) { setErr((e as Error).message) }
  }

  return (
    <div className="settings-section cred-form">
      <div className="section-head">
        <h2>{cred ? 'Edit login' : 'Add login'}</h2>
        <button className="btn btn-ghost btn-sm" onClick={onDone}>Cancel</button>
      </div>
      <label className="field"><span className="field-label">Site</span>
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://www.linkedin.com/login" />
        <span className="field-hint">The password is only ever typed on this site and its subdomains.</span>
      </label>
      <label className="field"><span className="field-label">Name</span>
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. LinkedIn (work)" />
      </label>
      <label className="field"><span className="field-label">Username or email</span>
        <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" />
      </label>
      <div className="field"><span className="field-label">Password</span>
        <div className="pw-row">
          <input type={shown ? 'text' : 'password'} value={password} autoComplete="new-password"
            placeholder={cred?.has_secret ? '•••••••• saved — type to change' : ''}
            onChange={(e) => setPassword(e.target.value)} />
          {(cred?.has_secret || password) && <button className="btn btn-ghost btn-sm" onClick={reveal}>{shown ? 'Hide' : 'Show'}</button>}
        </div>
      </div>
      <label className="field"><span className="field-label">Notes for the bot</span>
        <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)}
          placeholder="e.g. Sign in with email, not phone. MFA goes to my phone — ask me." />
        <span className="field-hint">The bot can read these. Don't put secrets here.</span>
      </label>
      <div className="field"><span className="field-label">Which bots may use it</span>
        <div className="bot-checks">
          <button className={`chip ${botIds.length === 0 ? 'chip-on' : ''}`} onClick={() => setBotIds([])}>All bots</button>
          {bots.map((b) => (
            <button key={b.id} className={`chip ${botIds.includes(b.id) ? 'chip-on' : ''}`} onClick={() => toggleBot(b.id)}>
              <Avatar bot={b} size={16} />{b.name}
            </button>
          ))}
        </div>
      </div>
      {err && <p className="hint err">{err}</p>}
      <div className="form-actions">
        <button className="btn" onClick={submit}>{cred ? 'Save' : 'Add login'}</button>
        {cred && (confirmDelete
          ? <><span className="dim">Delete this login?</span>
              <button className="btn btn-danger btn-sm" onClick={async () => { await api.deleteCredential(cred.id); onDone() }}>Delete</button>
              <button className="btn btn-ghost btn-sm" onClick={() => setConfirmDelete(false)}>Keep</button></>
          : <button className="btn btn-ghost btn-sm" onClick={() => setConfirmDelete(true)}>Delete</button>)}
      </div>
    </div>
  )
}
