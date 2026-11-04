import { useState } from 'react'
import { api } from '../api.ts'

/** Reused during setup and in Settings; keys are write-only. */
export function ProviderConnection({ onSaved, setup = false, initialURL = 'http://localhost:11434/v1' }: { onSaved?: () => void; setup?: boolean; initialURL?: string }) {
  const [provider, setProvider] = useState('local')
  const [url, setUrl] = useState(initialURL)
  const [key, setKey] = useState('')
  const [model, setModel] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  return <form onSubmit={async e => {
    e.preventDefault(); setBusy(true); setNote('')
    try {
      if (provider === 'local') await api.saveSettings({ local_url: url.trim() })
      if (key.trim()) await api.setProviderKey(provider, key.trim())
      if (setup) {
        const id = `${provider}::${model.trim()}`
        await api.saveSettings({ models: { worker: id, classifier: id, vision: '' } })
      }
      setKey(''); setNote('Saved. Model IDs use local:: or openai:: prefixes.'); onSaved?.()
    } catch (err) { setNote((err as Error).message) } finally { setBusy(false) }
  }}>
    <label className="field"><span className="field-label">Provider</span>
      <select value={provider} onChange={e => setProvider(e.target.value)}>
        <option value="local">Local / OpenAI-compatible</option><option value="openai">OpenAI</option>
        {!setup && <option value="openrouter">OpenRouter</option>}
      </select>
    </label>
    {provider === 'local' && <label className="field"><span className="field-label">API base URL</span>
      <input required value={url} onChange={e => setUrl(e.target.value)} placeholder="http://localhost:11434/v1" />
      <span className="field-hint">The daemon connects to this address. LM Studio commonly uses port 1234. This does not start a server.</span>
    </label>}
    <label className="field"><span className="field-label">API key {provider === 'local' ? '(optional)' : ''}</span>
      <input type="password" autoComplete="new-password" value={key} onChange={e => setKey(e.target.value)} placeholder="Blank keeps the saved key" required={setup && provider !== 'local'} />
    </label>
    {setup && <label className="field"><span className="field-label">Model ID</span>
      <input required value={model} onChange={e => setModel(e.target.value)} placeholder="Exact model ID from your server" />
    </label>}
    <button className="btn btn-sm" disabled={busy}>{busy ? 'Saving…' : 'Save connection'}</button>
    {note && <p role="status" className="field-hint">{note}</p>}
  </form>
}
