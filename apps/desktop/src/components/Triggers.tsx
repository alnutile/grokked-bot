import { useEffect, useState } from 'react'
import { writeText } from '@tauri-apps/plugin-clipboard-manager'
import { api, type Bot, type RemoteStatus, type Trigger, type TriggerInput } from '../api.ts'

const copy = (t: string) => writeText(t).catch(() => navigator.clipboard.writeText(t))
const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone

const PRESETS: Array<{ label: string; cron: string }> = [
  { label: 'Every weekday at 8:00', cron: '0 8 * * 1-5' },
  { label: 'Every day at 8:00', cron: '0 8 * * *' },
  { label: 'Every Monday at 9:00', cron: '0 9 * * 1' },
  { label: 'Every hour', cron: '0 * * * *' },
  { label: 'Every 15 minutes', cron: '*/15 * * * *' },
]
const describe = (t: Trigger) =>
  PRESETS.find((p) => p.cron === t.cron)?.label ?? `cron ${t.cron}`
const when = (ms: number | null) => (ms ? new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'never')

/** Webhooks and schedules: what can start this bot besides you. */
export function Triggers({ bot, onOpenThread }: { bot: Bot; onOpenThread: (threadId: string) => void }) {
  const [list, setList] = useState<Trigger[] | null>(null)
  const [remote, setRemote] = useState<RemoteStatus | null>(null)
  const [editing, setEditing] = useState<Trigger | 'webhook' | 'cron' | null>(null)
  const [token, setToken] = useState<{ id: string; token: string } | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const load = () => api.triggers(bot.id).then(setList).catch((e) => setErr(String(e.message)))
  useEffect(() => {
    void load()
    void api.remote().then(setRemote).catch(() => {})
    const t = setInterval(load, 10_000)
    return () => clearInterval(t)
  }, [bot.id])

  if (editing) {
    return <TriggerForm bot={bot} trigger={typeof editing === 'string' ? null : editing}
      kind={typeof editing === 'string' ? editing : editing.kind}
      onDone={(created) => { setEditing(null); if (created?.token) setToken({ id: created.id, token: created.token }); void load() }} />
  }

  return (
    <div className="triggers">
      <div className="media-head">
        <span className="dim">What can start {bot.name} besides you</span>
        <span className="row-gap">
          <button className="btn btn-sm" onClick={() => setEditing('webhook')}>Add webhook</button>
          <button className="btn btn-sm" onClick={() => setEditing('cron')}>Add schedule</button>
        </span>
      </div>
      {err && <p className="hint err">{err}</p>}
      {list?.length === 0 && (
        <p className="dim media-empty">
          No triggers yet. A <b>webhook</b> lets another app or device start {bot.name} with a POST; a <b>schedule</b> runs
          it on its own, like “check my email every weekday at 8”.
        </p>
      )}
      {list?.map((t) => (
        <TriggerCard key={t.id} t={t} remote={remote} token={token?.id === t.id ? token.token : null}
          onEdit={() => setEditing(t)} onChanged={load} onOpenThread={onOpenThread}
          onToken={(tok) => setToken({ id: t.id, token: tok })} onError={setErr} />
      ))}
    </div>
  )
}

function TriggerCard({ t, remote, token, onEdit, onChanged, onOpenThread, onToken, onError }: {
  t: Trigger; remote: RemoteStatus | null; token: string | null
  onEdit: () => void; onChanged: () => void; onOpenThread: (id: string) => void
  onToken: (tok: string) => void; onError: (e: string) => void
}) {
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const act = async (fn: () => Promise<unknown>, done?: string) => {
    try { await fn(); if (done) setNote(done); onChanged() } catch (e) { onError((e as Error).message) }
  }

  // The URL to give out: public hooks via Funnel when that's on, else the tailnet, else local.
  const url = t.kind !== 'webhook' ? null
    : t.public && remote?.funnel ? `${remote.public_base}/hooks/${t.id}`
    : remote?.serving ? `${remote.tailnet_base}/hooks/${t.id}`
    : `${remote?.local_base ?? 'http://127.0.0.1:8788'}/${t.public ? 'public/' : ''}hooks/${t.id}`
  const curl = url && `curl -X POST ${url} \\\n  -H "Authorization: Bearer ${token ?? '$GROKKED_HOOK_TOKEN'}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"prompt": "…", "payload": {}, "wait": 120}'`

  return (
    <div className={`trigger ${t.enabled ? '' : 'trigger-off'}`}>
      <div className="trigger-head">
        <span className="trigger-icon">{t.kind === 'webhook' ? '⚡' : '⏰'}</span>
        <span className="trigger-meta">
          <span className="trigger-name">{t.name}</span>
          <span className="field-hint">
            {t.kind === 'webhook'
              ? `${t.public ? 'Public' : 'Tailnet only'} · fired ${t.fire_count}× · last ${when(t.last_fire_at)}`
              : `${describe(t)} (${t.tz || 'local'}) · next ${t.enabled ? when(t.next_fire_at) : 'paused'}`}
            {t.last_run_state ? ` · last run ${t.last_run_state}` : ''}
          </span>
        </span>
        <label className="switch" title={t.enabled ? 'On' : 'Off'}>
          <input type="checkbox" checked={t.enabled} onChange={(e) => act(() => api.updateTrigger(t.id, { enabled: e.target.checked }))} />
          <span />
        </label>
      </div>
      <div className="trigger-instruction">{t.instruction}</div>

      {token && (
        <div className="token-box">
          <b>Token — copy it now, it won't be shown again</b>
          <code>{token}</code>
          <button className="btn btn-sm" onClick={() => copy(token).then(() => setNote('Token copied'))}>Copy token</button>
        </div>
      )}

      {url && (
        <div className="hook-url">
          <code>{url}</code>
          <button className="btn btn-ghost btn-sm" onClick={() => copy(url).then(() => setNote('URL copied'))}>Copy URL</button>
          <button className="btn btn-ghost btn-sm" onClick={() => copy(curl!).then(() => setNote('curl copied'))}>Copy curl</button>
          {!remote?.serving && (!t.public && remote?.funnel
            ? <span className="field-hint">Local only for now. Public webhooks (Funnel) are on, but this hook is tailnet-only, so the Funnel URL won't answer for it. Mark it Public to call it from anywhere, or turn on Webhooks on my tailnet in Settings → Remote access for your own devices.</span>
            : <span className="field-hint">Local only for now. Turn on Webhooks on my tailnet in Settings → Remote access to reach it from your other devices.</span>)}
          {t.public && remote?.serving && !remote.funnel && <span className="field-hint">Marked public, but Funnel is off in Settings → Remote access, so it's tailnet-only for now.</span>}
        </div>
      )}

      <div className="form-actions">
        <button className="btn btn-ghost btn-sm" onClick={() => act(() => api.runTrigger(t.id), 'Started')}>Run now</button>
        {t.thread_id && <button className="btn btn-ghost btn-sm" onClick={() => onOpenThread(t.thread_id!)}>History</button>}
        <button className="btn btn-ghost btn-sm" onClick={onEdit}>Edit</button>
        {t.kind === 'webhook' && (
          <button className="btn btn-ghost btn-sm" onClick={() => act(async () => onToken(await api.rotateTriggerToken(t.id)))}
            title="The old token stops working immediately">New token</button>
        )}
        {confirmDelete
          ? <><span className="dim">Delete?</span>
              <button className="btn btn-danger btn-sm" onClick={() => act(() => api.deleteTrigger(t.id))}>Delete</button>
              <button className="btn btn-ghost btn-sm" onClick={() => setConfirmDelete(false)}>Keep</button></>
          : <button className="btn btn-ghost btn-sm" onClick={() => setConfirmDelete(true)}>Delete</button>}
        <span className="overlay-note">{note}</span>
      </div>
    </div>
  )
}

function TriggerForm({ bot, trigger, kind, onDone }: {
  bot: Bot; trigger: Trigger | null; kind: 'webhook' | 'cron'
  onDone: (created?: { id: string; token?: string }) => void
}) {
  const [name, setName] = useState(trigger?.name ?? '')
  const [instruction, setInstruction] = useState(trigger?.instruction ?? '')
  const [isPublic, setPublic] = useState(trigger?.public ?? false)
  const [cron, setCron] = useState(trigger?.cron ?? PRESETS[0]!.cron)
  const [tz, setTz] = useState(trigger?.tz || localTz)
  const [domains, setDomains] = useState((trigger?.allowed_domains ?? bot.default_domains).join(', '))
  const [budget, setBudget] = useState(trigger?.max_usd?.toString() ?? '')
  const [err, setErr] = useState<string | null>(null)
  const preset = PRESETS.find((p) => p.cron === cron)?.cron ?? 'custom'

  const submit = async () => {
    const body: TriggerInput = {
      name, instruction, allowed_domains: domains.split(',').map((s) => s.trim()).filter(Boolean),
      max_usd: budget.trim() ? Number(budget) : null,
      ...(kind === 'webhook' ? { public: isPublic } : { cron, tz }),
    }
    try {
      if (trigger) { await api.updateTrigger(trigger.id, body); onDone() }
      else { const r = await api.createTrigger(bot.id, { ...body, kind }); onDone({ id: r.trigger.id, token: r.token }) }
    } catch (e) { setErr((e as Error).message) }
  }

  return (
    <div className="details">
      <div className="section-head"><b>{trigger ? 'Edit' : 'New'} {kind === 'webhook' ? 'webhook' : 'schedule'}</b>
        <button className="btn btn-ghost btn-sm" onClick={() => onDone()}>Cancel</button></div>
      <label>Name
        <input value={name} onChange={(e) => setName(e.target.value)}
          placeholder={kind === 'webhook' ? 'e.g. Support email triage' : 'e.g. Morning inbox check'} />
      </label>
      <label>Instruction
        <textarea rows={4} value={instruction} onChange={(e) => setInstruction(e.target.value)}
          placeholder={kind === 'webhook'
            ? 'What to do with each request, e.g. "Triage the support email in the payload: summarise it and draft a reply."'
            : 'What to do each time, e.g. "Check my Gmail for anything from recruiters and summarise it."'} />
        <span className="field-hint">
          {kind === 'webhook'
            ? 'The standing job. Callers send a payload and may add a prompt on top; they can also tell the bot where to send its result.'
            : 'Runs as if you had sent it, in this schedule’s own conversation.'}
        </span>
      </label>
      {kind === 'webhook' ? (
        <div className="field"><span className="field-label">Who can reach it</span>
          <div className="bot-checks">
            <button className={`chip ${!isPublic ? 'chip-on' : ''}`} onClick={() => setPublic(false)}>Tailnet only</button>
            <button className={`chip ${isPublic ? 'chip-on' : ''}`} onClick={() => setPublic(true)}>Public (Funnel)</button>
          </div>
          <span className="field-hint">
            Tailnet only: your devices and services on Tailscale. Public: anyone with the URL and token — for services
            like GitHub or Stripe that can't join your tailnet.
          </span>
        </div>
      ) : (
        <>
          <label>When
            <select className="select" value={preset} onChange={(e) => e.target.value !== 'custom' && setCron(e.target.value)}>
              {PRESETS.map((p) => <option key={p.cron} value={p.cron}>{p.label}</option>)}
              <option value="custom">Custom (cron)</option>
            </select>
          </label>
          <label>Cron expression
            <input value={cron} onChange={(e) => setCron(e.target.value)} className="mono" />
            <span className="field-hint">minute hour day-of-month month weekday — e.g. <code>30 7 * * 1-5</code> is 7:30 on weekdays.</span>
          </label>
          <label>Time zone
            <input value={tz} onChange={(e) => setTz(e.target.value)} placeholder={localTz} />
          </label>
        </>
      )}
      <label>Sites it may visit
        <input value={domains} onChange={(e) => setDomains(e.target.value)} placeholder="any site — or e.g. gmail.com" />
      </label>
      <label>Max $ per run
        <input value={budget} onChange={(e) => setBudget(e.target.value)} inputMode="decimal" placeholder="the bot's default" />
      </label>
      {err && <p className="hint err">{err}</p>}
      <div className="form-actions"><button className="btn" onClick={submit}>{trigger ? 'Save' : 'Create'}</button></div>
    </div>
  )
}
