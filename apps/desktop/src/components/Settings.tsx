import { useEffect, useMemo, useState } from 'react'
import { api, type Bot, type Credential, type CredentialInput, type ModelInfo, type RemoteStatus, type Settings as SettingsT } from '../api.ts'
import { Avatar } from './Avatar.tsx'

type Section = 'general' | 'models' | 'passwords' | 'remote'

const PROVIDERS = [
  { id: 'google', label: 'Google', site: 'accounts.google.com' },
  { id: 'microsoft', label: 'Microsoft', site: 'login.microsoftonline.com' },
  { id: 'apple', label: 'Apple', site: 'appleid.apple.com' },
  { id: 'github', label: 'GitHub', site: 'github.com/login' },
]
const providerLabel = (id: string) => PROVIDERS.find((p) => p.id === id)?.label ?? id

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
          {([['general', 'General'], ['models', 'Models'], ['passwords', 'Passwords'], ['remote', 'Remote access']] as const).map(([k, label]) => (
            <button key={k} className={`settings-tab ${section === k ? 'settings-tab-on' : ''}`} onClick={() => setSection(k)}>
              {label}
            </button>
          ))}
          <span className="settings-note">{note}</span>
        </nav>
        <div className="settings-body">
          <button className="icon-btn settings-close" onClick={onClose} title="Close (Esc)">✕</button>
          {!settings && (section === 'general' || section === 'models') && <p className="dim">Loading…</p>}
          {section === 'remote' && <Remote />}
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
    return <CredentialForm cred={editing === 'new' ? null : editing} bots={bots} all={list ?? []}
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
            <span className="field-hint">
              {c.domain}
              {c.sign_in_with
                ? ` · signs in with ${providerLabel(c.sign_in_with)}${c.via_credential_id ? ` (${list?.find((x) => x.id === c.via_credential_id)?.username || 'linked'})` : ' — no account linked'}`
                : `${c.username ? ` · ${c.username}` : ''}${c.has_secret ? '' : ' · no password'}`}
            </span>
          </span>
          <span className="cred-bots">{c.bot_ids.length ? c.bot_ids.map(botName).join(', ') : 'All bots'}</span>
        </button>
      ))}
    </div>
  )
}

function CredentialForm({ cred, bots, all, onDone }: { cred: Credential | null; bots: Bot[]; all: Credential[]; onDone: () => void }) {
  const [signInWith, setSignInWith] = useState(cred?.sign_in_with ?? '')
  const [via, setVia] = useState(cred?.via_credential_id ?? '')
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
    const body: CredentialInput = { label, url, notes, bot_ids: botIds, sign_in_with: signInWith, via_credential_id: signInWith ? via : '' }
    if (!signInWith) {
      body.username = username
      if (password || !cred) body.password = password
    }
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
      <div className="field"><span className="field-label">How do you sign in?</span>
        <div className="bot-checks">
          <button className={`chip ${!signInWith ? 'chip-on' : ''}`} onClick={() => setSignInWith('')}>Username &amp; password</button>
          {PROVIDERS.map((p) => (
            <button key={p.id} className={`chip ${signInWith === p.id ? 'chip-on' : ''}`} onClick={() => setSignInWith(p.id)}>
              Sign in with {p.label}
            </button>
          ))}
        </div>
      </div>
      {signInWith ? (() => {
        const p = PROVIDERS.find((x) => x.id === signInWith)!
        // Suggest saved logins on the provider's own site first.
        const accounts = all.filter((c) => c.id !== cred?.id && !c.sign_in_with)
          .sort((a, b) => Number(b.domain.includes(p.id)) - Number(a.domain.includes(p.id)))
        return (
          <div className="field"><span className="field-label">Which {p.label} account</span>
            <select className="select" value={via} onChange={(e) => setVia(e.target.value)}>
              <option value="">— choose a saved login —</option>
              {accounts.map((c) => <option key={c.id} value={c.id}>{c.label}{c.username ? ` (${c.username})` : ''} · {c.domain}</option>)}
            </select>
            <span className="field-hint">
              Save your {p.label} account once as its own login (site <code>{p.site}</code>) and link it here. Every
              site that uses {p.label} can then share it; the password is still only typed on {p.label}'s own pages.
            </span>
          </div>
        )
      })() : (
        <>
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
        </>
      )}
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

/** Reaching webhooks from other devices: Tailscale by default, any tunnel otherwise. */
function Remote() {
  const [st, setSt] = useState<RemoteStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const load = () => api.remote().then(setSt).catch((e) => setErr(String(e.message)))
  useEffect(() => { void load() }, [])
  const set = async (b: { serve?: boolean; funnel?: boolean }) => {
    setBusy(true); setErr(null)
    try { setSt(await api.setTailscale(b)) } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }

  return (
    <div className="settings-section">
      <h2>Remote access</h2>
      <p className="dim">
        Webhooks have their own listener that serves nothing but <code>/hooks</code>, on port {st?.hooks_port ?? 8788}. Only
        that is ever exposed — the rest of the app stays on this machine.
      </p>

      <div className="remote-card">
        <b>Tailscale</b>
        {!st ? <p className="dim">Checking…</p>
          : !st.installed ? <p className="dim">Not installed. Get it at tailscale.com/download, then come back here.</p>
          : !st.logged_in ? (
              <p className="dim">Installed but not signed in. Run <code>sudo tailscale up</code>
                {st.login_url ? <> or open <code>{st.login_url}</code></> : null}, then <button className="btn btn-ghost btn-sm" onClick={load}>Check again</button></p>
            ) : (
              <>
                <p className="field-hint">This machine is <code>{st.dns_name}</code> on your tailnet.</p>
                <label className="switch-row">
                  <span><b>Webhooks on my tailnet</b><br /><span className="field-hint">{st.tailnet_base}/hooks/… — your devices and services on Tailscale.</span></span>
                  <span className="switch"><input type="checkbox" disabled={busy} checked={st.serving} onChange={(e) => set({ serve: e.target.checked })} /><span /></span>
                </label>
                <label className="switch-row">
                  <span><b>Public webhooks (Funnel)</b><br /><span className="field-hint">{st.public_base}/hooks/… — only hooks you mark Public, for services that can't join your tailnet.</span></span>
                  <span className="switch"><input type="checkbox" disabled={busy} checked={st.funnel} onChange={(e) => set({ funnel: e.target.checked })} /><span /></span>
                </label>
              </>
            )}
        {err && <p className="hint err">{err}</p>}
      </div>

      <div className="remote-card">
        <b>Not using Tailscale?</b>
        <p className="field-hint">
          Point any tunnel at <code>http://127.0.0.1:{st?.hooks_port ?? 8788}</code>: <b>Headscale</b> (open-source Tailscale
          control server — the same switches above then work), <b>WireGuard</b>, <b>Caddy</b>, or a <b>Cloudflare Tunnel</b>.
          Expose <code>/hooks</code> to your private network and <code>/public/hooks</code> to the internet; the second only
          answers for hooks marked Public. To listen beyond this machine directly, set
          <code> GROKKED_HOOKS_HOST=0.0.0.0</code> in <code>~/.config/grokked/env</code> and restart the daemon.
        </p>
      </div>
    </div>
  )
}
