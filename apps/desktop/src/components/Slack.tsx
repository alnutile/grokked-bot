import { useEffect, useState } from 'react'
import { openUrl, revealItemInDir } from '@tauri-apps/plugin-opener'
import { api, type Bot, type BotSlack } from '../api.ts'
import { Avatar, avatarBackground, avatarPng } from './Avatar.tsx'
import { copyText } from './Thread.tsx'

const open = (url: string) => openUrl(url).catch(() => window.open(url, '_blank'))

/** Turns the bot into a Slack teammate: its own Slack app, set up step by step. */
export function Slack({ bot }: { bot: Bot }) {
  const [s, setS] = useState<BotSlack | null>(null)
  const [botToken, setBotToken] = useState('')
  const [appToken, setAppToken] = useState('')
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [iconPath, setIconPath] = useState<string | null>(null)
  const [confirmOff, setConfirmOff] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const load = () => api.slack(bot.id, avatarBackground(bot)).then(setS).catch((e) => setErr(String(e.message)))
  useEffect(() => {
    setS(null); setEditing(false); setBotToken(''); setAppToken(''); setIconPath(null); setErr(null); setConfirmOff(false)
    void load()
  }, [bot.id])
  // While it's connecting, check back so the status settles on its own.
  useEffect(() => {
    if (s?.status.state !== 'connecting') return
    const t = setTimeout(load, 2000)
    return () => clearTimeout(t)
  }, [s])

  const run = async (f: () => Promise<BotSlack>) => {
    setBusy(true)
    try { setS(await f()); setErr(null); return true } catch (e) { setErr((e as Error).message); return false } finally { setBusy(false) }
  }
  const connect = async () => {
    if (await run(() => api.slackConnect(bot.id, { bot_token: botToken.trim(), app_token: appToken.trim() }))) {
      setEditing(false); setBotToken(''); setAppToken('')
    }
  }
  const saveIcon = async () => {
    try {
      const { path } = await api.slackSaveIcon(bot.id, await avatarPng(bot))
      setIconPath(path)
      revealItemInDir(path).catch(() => {})
    } catch (e) { setErr((e as Error).message) }
  }

  if (!s) return <div className="details">{err ? <p className="hint err">{err}</p> : <p className="dim">Loading…</p>}</div>

  const tokenForm = (
    <>
      <label>Bot User OAuth Token
        <input type="password" placeholder={s.configured ? 'Leave blank to keep the current one' : 'xoxb-…'} value={botToken}
          onChange={(e) => setBotToken(e.target.value)} autoComplete="off" />
      </label>
      <label>App-Level Token
        <input type="password" placeholder={s.configured ? 'Leave blank to keep the current one' : 'xapp-…'} value={appToken}
          onChange={(e) => setAppToken(e.target.value)} autoComplete="off" />
      </label>
      <div className="row-gap">
        <button className="btn btn-sm" disabled={busy || (!s.configured && (!botToken.trim() || !appToken.trim()))} onClick={connect}>
          {busy ? 'Checking with Slack…' : s.configured ? 'Save tokens' : 'Connect'}
        </button>
        {s.configured && <button className="btn btn-ghost btn-sm" onClick={() => setEditing(false)}>Cancel</button>}
      </div>
      <span className="field-hint">Both are checked with Slack before they're saved, then stored encrypted like your passwords.</span>
    </>
  )

  if (!s.configured) {
    return (
      <div className="details">
        <span className="field-hint">
          Put {bot.name} in Slack as its own teammate. People DM it or @mention it in a channel, it reacts 👀, shows
          what it's doing, and answers in the thread. Your computer connects out to Slack, so there's no public URL
          or tunnel to set up. About 5 minutes.
        </span>
        <ol className="slack-steps">
          <li>
            <b>Create the app.</b> Copy the manifest, then on Slack choose <i>Create New App → From a manifest</i>, pick
            your workspace, paste it and click <i>Create</i>. It sets {bot.name}'s name, permissions and Socket Mode.
            <div className="row-gap">
              <button className="btn btn-sm" onClick={() => copyText(s.manifest).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) })}>
                {copied ? '✓ Copied' : '⧉ Copy manifest'}
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => open('https://api.slack.com/apps?new_app=1')}>Open Slack apps ↗</button>
            </div>
            <details className="slack-manifest"><summary>Show manifest</summary><pre>{s.manifest}</pre></details>
          </li>
          <li>
            <b>Give it its face.</b> In <i>Basic Information → Display Information</i>, upload this as the app icon.
            <div className="row-gap">
              <span className="slack-icon" style={{ background: avatarBackground(bot) }}><Avatar bot={bot} size={30} /></span>
              <button className="btn btn-ghost btn-sm" onClick={saveIcon}>Save icon to Downloads</button>
            </div>
            {iconPath && <span className="field-hint">Saved {iconPath}</span>}
          </li>
          <li>
            <b>Make the app token.</b> Still in <i>Basic Information</i>, under <i>App-Level Tokens</i> click{' '}
            <i>Generate Token and Scopes</i>, name it anything, add the <code>connections:write</code> scope, and copy
            the <code>xapp-</code> token.
          </li>
          <li>
            <b>Install it.</b> In <i>Install App</i>, click <i>Install to Workspace</i> and <i>Allow</i>, then copy the{' '}
            <i>Bot User OAuth Token</i> (<code>xoxb-</code>).
          </li>
          <li><b>Paste both here.</b></li>
        </ol>
        {tokenForm}
        {err && <p className="hint err">{err}</p>}
      </div>
    )
  }

  const st = s.status.state
  const dot = !s.enabled ? 'off' : st
  const label = !s.enabled ? 'Paused' : st === 'connected' ? 'Connected' : st === 'connecting' ? 'Connecting…' : 'Not connected'
  const dm = s.team_id && s.bot_user_id ? `slack://user?team=${s.team_id}&id=${s.bot_user_id}` : null

  return (
    <div className="details">
      <div className="slack-status">
        <span className={`slack-dot slack-${dot}`} />
        <div>
          <b>{label}</b>
          <span className="field-hint"> to {s.team_name ?? 'Slack'} as @{s.bot_user_name ?? bot.name}</span>
          {s.enabled && st === 'error' && s.status.detail && <div className="hint err">{s.status.detail}</div>}
        </div>
      </div>
      <div className="row-gap">
        {dm && <button className="btn btn-sm" onClick={() => open(dm)}>Message {bot.name} in Slack ↗</button>}
        {s.app_id && <button className="btn btn-ghost btn-sm" onClick={() => open(`https://api.slack.com/apps/${s.app_id}`)}>App settings ↗</button>}
      </div>
      <span className="field-hint">
        DM it, or add it to a channel (<code>/invite @{s.bot_user_name ?? bot.name}</code>) and @mention it. Replies in
        its threads don't need the @. Each thread is a conversation here too.
      </span>

      <label>Who can use it</label>
      <div className="slack-access">
        <label className="radio"><input type="radio" checked={!s.allow_all} onChange={() => run(() => api.slackUpdate(bot.id, { allow_all: false }))} /> Only these people</label>
        {!s.allow_all && (
          s.allowed_users.length ? (
            <div className="env-list">
              {s.allowed_users.map((u) => (
                <div key={u.id} className="env-row slack-user">
                  <span>{u.name}</span>
                  <button className="btn btn-ghost btn-sm" title="Remove"
                    onClick={() => run(() => api.slackUpdate(bot.id, { allowed_users: s.allowed_users.filter((x) => x.id !== u.id) }))}>✕</button>
                </div>
              ))}
            </div>
          ) : <span className="field-hint">The first person to message {bot.name} is added here. That should be you.</span>
        )}
        <label className="radio"><input type="radio" checked={s.allow_all} onChange={() => run(() => api.slackUpdate(bot.id, { allow_all: true }))} /> Anyone in the workspace</label>
        <span className="field-hint">
          Whoever can use it can have it use its computer, logins, Env and SSH. People not on the list get a polite
          “ask {s.allowed_users[0]?.name ?? 'the owner'} to add you”.
        </span>
      </div>

      <label>Connection</label>
      {editing ? tokenForm : (
        <div className="row-gap">
          <button className="btn btn-ghost btn-sm" onClick={() => run(() => api.slackUpdate(bot.id, { enabled: !s.enabled }))}>{s.enabled ? 'Pause' : 'Resume'}</button>
          <button className="btn btn-ghost btn-sm" onClick={() => setEditing(true)}>Update tokens</button>
          {confirmOff ? (
            <>
              <button className="btn btn-sm" onClick={() => { setConfirmOff(false); void run(() => api.slackDisconnect(bot.id)) }}>Disconnect</button>
              <button className="btn btn-ghost btn-sm" onClick={() => setConfirmOff(false)}>Cancel</button>
            </>
          ) : <button className="btn btn-ghost btn-sm" onClick={() => setConfirmOff(true)}>Disconnect…</button>}
        </div>
      )}
      {confirmOff && <span className="field-hint">Forgets the tokens. The app stays in Slack until you delete it there.</span>}
      {err && <p className="hint err">{err}</p>}
    </div>
  )
}
