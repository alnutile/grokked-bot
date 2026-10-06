import { useEffect, useState } from 'react'
import { openUrl } from '@tauri-apps/plugin-opener'
import { api, type SystemStatus } from '../api.ts'

/** Everything a bot needs that the app can't ship inside itself. */
export const setupDone = (s: SystemStatus) =>
  s.docker === 'ok' && s.image_state === 'present' && s.openrouter_key

const open = (url: string) => openUrl(url).catch(() => window.open(url, '_blank'))

/**
 * First-run checklist. On a Mac the .dmg is the whole installer, so whatever it
 * can't bundle (Docker, the 5GB bot computer, an OpenRouter key) gets set up
 * here, one step at a time, instead of in a README.
 */
export function Setup({ status, onChange }: { status: SystemStatus; onChange: (s: SystemStatus) => void }) {
  const [key, setKey] = useState('')
  const [keyErr, setKeyErr] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  // Docker starting and the image pulling both happen outside the app, so poll.
  useEffect(() => {
    const t = setInterval(() => api.system().then(onChange).catch(() => {}), 2000)
    return () => clearInterval(t)
  }, [onChange])

  const mac = status.platform === 'darwin'
  const dockerOk = status.docker === 'ok'

  return (
    <div className="boot setup">
      <h1>Set up Grokked Bot</h1>
      <p className="boot-msg">Each bot gets its own computer, a Linux desktop that runs in Docker on this machine.</p>

      <ol className="steps">
        <li className={dockerOk ? 'done' : 'todo'}>
          <strong>Docker</strong>
          {status.docker === 'missing' && <>
            <p>{mac
              ? 'Install Docker Desktop (or OrbStack), open it once, then come back here.'
              : 'Install Docker, then come back here.'}</p>
            <button className="btn" onClick={() => open(mac
              ? 'https://www.docker.com/products/docker-desktop/'
              : 'https://docs.docker.com/engine/security/rootless/')}>Get Docker</button>
          </>}
          {status.docker === 'not_running' && <>
            <p>Docker is installed but not running. {mac ? 'Open Docker Desktop and wait for it to say it’s running.' : 'Start the Docker service.'}</p>
            {status.docker_detail && <p className="hint">{status.docker_detail}</p>}
          </>}
          {dockerOk && <p>Running.</p>}
        </li>

        <li className={status.image_state === 'present' ? 'done' : 'todo'}>
          <strong>Bot computer</strong>
          {!dockerOk && <p className="hint">Needs Docker first.</p>}
          {dockerOk && (status.image_state === 'missing' || status.image_state === 'failed') && <>
            <p>A one-time download of about 5 GB.</p>
            {status.pull_error && <p className="hint err">{status.pull_error}</p>}
            <button className="btn" onClick={() => api.pull().then(() => api.system()).then(onChange)}>
              {status.image_state === 'failed' ? 'Try again' : 'Download'}
            </button>
          </>}
          {status.image_state === 'pulling' && <>
            <p><span className="dot" /> Downloading… you can leave this open.</p>
            {status.pull_progress && <p className="hint mono">{status.pull_progress}</p>}
          </>}
          {status.image_state === 'present' && <p>Ready.</p>}
        </li>

        <li className={status.openrouter_key ? 'done' : 'todo'}>
          <strong>OpenRouter key</strong>
          {status.openrouter_key
            ? <p>Saved.</p>
            : <>
                <p>Bots think with models from OpenRouter, billed to your account.{' '}
                  <a href="#" onClick={(e) => { e.preventDefault(); void open('https://openrouter.ai/settings/keys') }}>Create a key</a>.
                </p>
                <form className="key-row" onSubmit={async (e) => {
                  e.preventDefault()
                  setSaving(true); setKeyErr(null)
                  try {
                    await api.setKey(key)
                    onChange(await api.system())
                  } catch (err) {
                    setKeyErr(/invalid_key/.test(String(err)) ? 'OpenRouter rejected that key.' : String(err))
                  } finally {
                    setSaving(false)
                  }
                }}>
                  <input type="password" placeholder="sk-or-v1-…" value={key} onChange={(e) => setKey(e.target.value)} />
                  <button className="btn" disabled={!key.trim() || saving}>{saving ? 'Checking…' : 'Save'}</button>
                </form>
                {keyErr && <p className="hint err">{keyErr}</p>}
              </>}
        </li>
      </ol>
    </div>
  )
}
