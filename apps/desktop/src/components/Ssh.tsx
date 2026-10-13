import { useEffect, useState } from 'react'
import { api, type Bot, type BotSsh, type SshHost } from '../api.ts'
import { copyText } from './Thread.tsx'

/** The bot's own SSH key, and the servers it may log in to. */
export function Ssh({ bot }: { bot: Bot }) {
  const [ssh, setSsh] = useState<BotSsh | null>(null)
  const [hosts, setHosts] = useState<SshHost[]>([])
  const [dirty, setDirty] = useState(false)
  const [confirmRotate, setConfirmRotate] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)
  const [tests, setTests] = useState<Record<number, { busy?: boolean; ok?: boolean; message?: string }>>({})
  const [err, setErr] = useState<string | null>(null)

  const take = (s: BotSsh) => { setSsh(s); setHosts(s.hosts); setDirty(false) }
  useEffect(() => {
    setSsh(null); setTests({}); setConfirmRotate(false); setErr(null)
    api.ssh(bot.id).then(take).catch((e) => setErr(String(e.message)))
  }, [bot.id])

  const run = async (f: () => Promise<BotSsh>) => {
    try { take(await f()); setErr(null) } catch (e) { setErr((e as Error).message) }
  }
  const copy = (what: string, text: string) => copyText(text).then(() => { setCopied(what); setTimeout(() => setCopied(null), 1500) })
  const edit = (i: number, patch: Partial<SshHost>) => {
    setHosts((h) => h.map((x, j) => (j === i ? { ...x, ...patch } : x))); setDirty(true)
    setTests((t) => ({ ...t, [i]: {} }))
  }
  const test = async (i: number) => {
    setTests((t) => ({ ...t, [i]: { busy: true } }))
    const r = await api.sshTest(bot.id, hosts[i]!).catch((e) => ({ ok: false, message: (e as Error).message }))
    setTests((t) => ({ ...t, [i]: r }))
  }

  if (!ssh) return <div className="details">{err ? <p className="hint err">{err}</p> : <p className="dim">Loading…</p>}</div>

  if (!ssh.public_key) {
    return (
      <div className="details">
        <span className="field-hint">
          Give {bot.name} its own SSH key so it can log in to your servers with <code>ssh</code>, <code>scp</code> and{' '}
          <code>rsync</code>. You add its public key to a server, the same way you'd add a teammate's.
        </span>
        <div className="row-gap"><button className="btn btn-sm" onClick={() => run(() => api.sshCreateKey(bot.id))}>Create SSH key</button></div>
        <span className="field-hint">
          Each bot gets a different key, so you can let one in (or shut it out) without touching anyone else's
          access. The private key is stored encrypted and never written to the bot's disk; the bot can use it but
          can't read it.
        </span>
        {err && <p className="hint err">{err}</p>}
      </div>
    )
  }

  const install = `mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo '${ssh.public_key}' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys`

  return (
    <div className="details">
      <label>Public key</label>
      <code className="ssh-key">{ssh.public_key}</code>
      <div className="row-gap">
        <button className="btn btn-sm" onClick={() => copy('key', ssh.public_key)}>{copied === 'key' ? '✓ Copied' : '⧉ Copy key'}</button>
        <span className="field-hint ssh-fp" title="Shown in the server's auth log when the bot logs in">{ssh.fingerprint}</span>
      </div>

      <label>Let it into a server</label>
      <span className="field-hint">
        Log in to the server as the user {bot.name} should be, and run this. It adds the key to that user's{' '}
        <code>~/.ssh/authorized_keys</code>.
      </span>
      <code className="ssh-key ssh-cmd">{install}</code>
      <div className="row-gap">
        <button className="btn btn-sm btn-ghost" onClick={() => copy('cmd', install)}>{copied === 'cmd' ? '✓ Copied' : '⧉ Copy command'}</button>
      </div>

      <label>Servers</label>
      <span className="field-hint">
        Tell {bot.name} which servers it may use, so you can say “check the disk on <i>web</i>”. Test checks that the
        server lets it in.
      </span>
      {hosts.length > 0 && (
        <div className="ssh-hosts">
          {hosts.map((h, i) => (
            <div key={i} className="ssh-host">
              <div className="ssh-host-row">
                <input placeholder="Name (web)" value={h.name} onChange={(e) => edit(i, { name: e.target.value })} />
                <input placeholder="user@host" value={h.target} onChange={(e) => edit(i, { target: e.target.value.trim() })} />
                <input placeholder="22" className="ssh-port" value={h.port ?? ''} inputMode="numeric"
                  onChange={(e) => edit(i, { port: e.target.value ? Number(e.target.value.replace(/\D/g, '')) || undefined : undefined })} />
              </div>
              <div className="ssh-host-row">
                <input placeholder="Note for the bot (optional): what it's for, what not to touch" value={h.note ?? ''}
                  onChange={(e) => edit(i, { note: e.target.value })} />
                <button className="btn btn-ghost btn-sm" disabled={tests[i]?.busy || !h.target} onClick={() => test(i)}>
                  {tests[i]?.busy ? 'Testing…' : 'Test'}
                </button>
                <button className="btn btn-ghost btn-sm" title="Remove" onClick={() => { setHosts((x) => x.filter((_, j) => j !== i)); setDirty(true); setTests({}) }}>✕</button>
              </div>
              {tests[i]?.message && <span className={`hint ${tests[i]?.ok ? 'ok' : 'err'}`}>{tests[i]?.ok ? '✓ ' : ''}{tests[i]?.message}</span>}
            </div>
          ))}
        </div>
      )}
      <div className="row-gap">
        <button className="btn btn-ghost btn-sm" onClick={() => { setHosts((h) => [...h, { name: '', target: '' }]); setDirty(true) }}>+ Add server</button>
        {dirty && <button className="btn btn-sm" onClick={() => run(() => api.sshSaveHosts(bot.id, hosts))}>Save servers</button>}
      </div>

      <label>Key</label>
      {confirmRotate ? (
        <div className="row-gap">
          <span className="field-hint">The current key stops working on every server.</span>
          <button className="btn btn-sm" onClick={() => { setConfirmRotate(false); run(() => api.sshCreateKey(bot.id)) }}>Make a new key</button>
          <button className="btn btn-ghost btn-sm" onClick={() => { setConfirmRotate(false); run(() => api.sshRemoveKey(bot.id)) }}>Remove key</button>
          <button className="btn btn-ghost btn-sm" onClick={() => setConfirmRotate(false)}>Cancel</button>
        </div>
      ) : (
        <div className="row-gap">
          <button className="btn btn-ghost btn-sm" onClick={() => setConfirmRotate(true)}>Replace or remove key…</button>
          {ssh.created_at && <span className="field-hint">Made {new Date(ssh.created_at).toLocaleDateString()}</span>}
        </div>
      )}
      {err && <p className="hint err">{err}</p>}
    </div>
  )
}
