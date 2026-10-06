import { useEffect, useState } from 'react'
import { openUrl } from '@tauri-apps/plugin-opener'
import { api, type SystemStatus } from '../api.ts'
import { Mascot } from './Mascot.tsx'

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
      <Mascot size={104} mood={status.image_state === 'pulling' ? 'working' : 'idle'} />
      <h1>Hi! Let's get your bot its own computer.</h1>
      <p className="boot-msg setup-intro">
        Your bots don't work on your {mac ? 'Mac' : 'desktop'} directly. Each one gets a private computer of its
        own, a small Linux desktop with Chrome and a terminal, running quietly in the background. You can watch
        it work and take over the mouse any time. Three things and you're set:
      </p>

      <ol className="steps">
        <li className={dockerOk ? 'done' : 'todo'}>
          <strong>1. Docker</strong>
          <p className="why">The engine that runs your bots' computers.</p>
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
          <strong>2. The bot's computer</strong>
          <p className="why">A ready-made desktop your bots share as a template. Downloaded once.</p>
          {!dockerOk && <p className="hint">Needs Docker first.</p>}
          {dockerOk && (status.image_state === 'missing' || status.image_state === 'failed') && <>
            <p>A one-time download of about 5 GB.</p>
            {status.pull_error && <p className="hint err">{status.pull_error}</p>}
            <button className="btn" onClick={() => api.pull().then(() => api.system()).then(onChange)}>
              {status.image_state === 'failed' ? 'Try again' : 'Download'}
            </button>
          </>}
          {status.image_state === 'pulling' && <>
            <p><span className="dot" /> Downloading… this can take 10 minutes or so. Leave this window open.</p>
            {status.pull_progress && <p className="hint mono">{status.pull_progress}</p>}
          </>}
          {status.image_state === 'present' && <p>Ready.</p>}
        </li>

        <li className={status.openrouter_key ? 'done' : 'todo'}>
          <strong>3. An OpenRouter key</strong>
          <p className="why">How your bots think. Usage is billed to your OpenRouter account.</p>
          {status.openrouter_key
            ? <p>Saved.</p>
            : <>
                <p>Paste a key from OpenRouter.{' '}
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
