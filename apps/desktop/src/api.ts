import { invoke } from '@tauri-apps/api/core'

const BASE = 'http://127.0.0.1:8787'
let TOKEN = ''

export async function initToken(): Promise<void> {
  try {
    TOKEN = await invoke<string>('daemon_token')
  } catch {
    // Not running inside Tauri (plain browser, `pnpm dev`). Accept ?token= so the
    // UI can be iterated on without a 46s Rust rebuild each time.
    const q = new URLSearchParams(location.search).get('token')
    if (!q) throw new Error('no daemon token: run inside the app, or pass ?token=')
    TOKEN = q
  }
}

export const inTauri = () => '__TAURI_INTERNALS__' in globalThis

async function req<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
  })
  if (!res.ok) {
    const text = await res.text()
    let message = text
    try { message = (JSON.parse(text) as { message?: string }).message ?? text } catch { /* not JSON */ }
    throw new Error(message || `${res.status}`)
  }
  return (await res.json()) as T
}

export interface Bot {
  id: string; name: string; persona_md: string; description: string
  avatar: { shape?: number; hue?: number }
  default_domains: string[]; default_max_usd: number | null
  /** Overrides the Settings worker model for this bot; '' uses Settings. */
  worker_model: string
  autonomy: string; status: string; created_at: number
}

export interface ThreadSummary {
  id: string; bot_id: string; title: string | null; preview: string | null
  state: string | null; last_message_at: number
}

export interface Settings {
  models: { planner: string; worker: string; vision: string; distiller: string; classifier: string }
  defaults: { max_steps: number; max_usd: number; max_wall_s: number; max_screenshots: number }
}

export interface ModelInfo { id: string; name: string; context_length: number; prompt_per_m: number; completion_per_m: number }

export interface Credential {
  id: string; label: string; url: string; domain: string; username: string
  notes: string; bot_ids: string[]; has_secret: boolean; updated_at: number
}
export type CredentialInput = Partial<Pick<Credential, 'label' | 'url' | 'username' | 'notes' | 'bot_ids'>> & { password?: string }

export interface BotFile { path: string; abs: string; size: number; mtime: number }
/** A chat line rebuilt by the daemon from SQLite. */
export interface ThreadEntry {
  kind: 'goal' | 'say' | 'tool' | 'done' | 'ask' | 'error'
  text: string; tool?: string; status?: string; step?: number; run_id: string
}

export interface Run {
  id: string; bot_id: string; goal: string; state: string; state_reason: string | null
  step_no: number; max_steps: number; spend_usd: number; max_usd: number
  outcome: string | null; outcome_summary: string | null; created_at: number
}

export const api = {
  health: () => req<{ ok: boolean; version: string; active_runs: number }>('/v1/health'),
  bots: () => req<{ bots: Bot[] }>('/v1/bots').then((r) => r.bots),
  createBot: (name: string, persona_md = '') =>
    req<{ bot: Bot }>('/v1/bots', { method: 'POST', body: JSON.stringify({ name, persona_md }) }).then((r) => r.bot),
  runs: () => req<{ runs: Run[] }>('/v1/runs').then((r) => r.runs),
  run: (id: string) => req<{ run: Run }>(`/v1/runs/${id}`).then((r) => r.run),
  credits: () => req<{ total_credits: number; total_usage: number; remaining: number }>('/v1/credits'),
  resume: (id: string, add_usd?: number) =>
    req<{ ok: boolean; max_usd: number }>(`/v1/runs/${id}/resume`, {
      method: 'POST', body: JSON.stringify({ add_usd }),
    }),
  thread: (botId: string) =>
    req<{ thread_id: string | null; entries: ThreadEntry[]; run: Run | null }>(`/v1/bots/${botId}/thread`),
  newThread: (botId: string) => req<{ thread_id: string }>(`/v1/bots/${botId}/threads`, { method: 'POST' }),
  /** Omitted domains/budget fall back to the bot's defaults on the daemon. */
  createRun: (bot_id: string, goal: string, opts: {
    thread_id?: string | null; allowed_domains?: string[]; max_usd?: number
  } = {}) =>
    req<{ run: Run & { thread_id: string } }>('/v1/runs', {
      method: 'POST',
      body: JSON.stringify({
        bot_id, goal,
        ...(opts.thread_id ? { thread_id: opts.thread_id } : { new_thread: true }),
        ...(opts.allowed_domains ? { allowed_domains: opts.allowed_domains } : {}),
        ...(opts.max_usd ? { max_usd: opts.max_usd } : {}),
      }),
    }).then((r) => r.run),
  settings: () => req<Settings>('/v1/settings'),
  saveSettings: (patch: { models?: Partial<Settings['models']>; defaults?: Partial<Settings['defaults']> }) =>
    req<Settings>('/v1/settings', { method: 'PATCH', body: JSON.stringify(patch) }),
  models: () => req<{ models: ModelInfo[] }>('/v1/models').then((r) => r.models),
  credentials: () => req<{ credentials: Credential[] }>('/v1/credentials').then((r) => r.credentials),
  createCredential: (c: CredentialInput) =>
    req<{ credential: Credential }>('/v1/credentials', { method: 'POST', body: JSON.stringify(c) }).then((r) => r.credential),
  updateCredential: (id: string, c: CredentialInput) =>
    req<{ credential: Credential }>(`/v1/credentials/${id}`, { method: 'PATCH', body: JSON.stringify(c) }).then((r) => r.credential),
  deleteCredential: (id: string) => req(`/v1/credentials/${id}`, { method: 'DELETE' }),
  revealCredential: (id: string) => req<{ password: string }>(`/v1/credentials/${id}/reveal`).then((r) => r.password),
  updateBot: (id: string, patch: Partial<Pick<Bot, 'name' | 'description' | 'persona_md' | 'default_domains' | 'default_max_usd' | 'avatar' | 'worker_model'>>) =>
    req<{ bot: Bot }>(`/v1/bots/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }).then((r) => r.bot),
  threads: () => req<{ threads: ThreadSummary[] }>('/v1/threads').then((r) => r.threads),
  threadById: (id: string) =>
    req<{ thread: { id: string; bot_id: string; title: string | null }; entries: ThreadEntry[]; run: Run | null }>(`/v1/threads/${id}`),
  renameThread: (id: string, title: string) =>
    req(`/v1/threads/${id}`, { method: 'PATCH', body: JSON.stringify({ title }) }),
  files: (botId: string) => req<{ root: string; files: BotFile[] }>(`/v1/bots/${botId}/files`),
  /** A blob: URL for a file in the bot's work dir (img tags can't send the bearer token). */
  fileUrl: async (botId: string, path: string) => {
    const res = await fetch(`${BASE}/v1/bots/${botId}/files/raw?path=${encodeURIComponent(path)}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    })
    if (!res.ok) throw new Error(`${res.status}`)
    return URL.createObjectURL(await res.blob())
  },
  cancel: (id: string) => req(`/v1/runs/${id}/cancel`, { method: 'POST' }),
  computer: (botId: string) =>
    req<{ vnc_url: string | null; vnc_port: number | null; vnc_password: string | null; human_in_control: boolean }>(`/v1/bots/${botId}/computer`),
  startComputer: (botId: string) => req(`/v1/bots/${botId}/computer/start`, { method: 'POST' }),
  takeover: (botId: string) => req(`/v1/bots/${botId}/takeover`, { method: 'POST', body: '{"holder":"you"}' }),
  release: (botId: string) => req(`/v1/bots/${botId}/takeover`, { method: 'DELETE' }),
  botClipboard: (botId: string) =>
    req<{ text: string }>(`/v1/bots/${botId}/clipboard`).then((r) => r.text),
  setBotClipboard: (botId: string, text: string, paste = false) =>
    req(`/v1/bots/${botId}/clipboard`, { method: 'POST', body: JSON.stringify({ text, paste }) }),
  token: () => TOKEN,
}

export interface Frame { v: number; seq: number; ts: number; type: string; topic: string; data: any }

/**
 * The WS is a cache-invalidation channel, never the source of truth. We track the
 * last seq we saw and reconnect with `?since=`, so a daemon restart replays what
 * we missed instead of silently leaving the UI stale.
 */
export function connect(onFrame: (f: Frame) => void, onStatus: (s: 'up' | 'down') => void): () => void {
  let ws: WebSocket | null = null
  let closed = false
  let since = 0
  let retry: ReturnType<typeof setTimeout> | null = null
  const topics = new Set<string>(['approvals', 'notifications', 'system'])

  const open = () => {
    if (closed) return
    ws = new WebSocket(`ws://127.0.0.1:8787/v1/stream?token=${encodeURIComponent(TOKEN)}&since=${since}`)
    ws.onopen = () => {
      onStatus('up')
      ws?.send(JSON.stringify({ type: 'subscribe', topics: [...topics] }))
    }
    ws.onmessage = (ev) => {
      const f = JSON.parse(ev.data as string) as Frame
      if (f.seq > since) since = f.seq
      onFrame(f)
    }
    ws.onclose = () => { onStatus('down'); if (!closed) retry = setTimeout(open, 1500) }
    ws.onerror = () => ws?.close()
  }
  open()

  ;(globalThis as any).__grokkedSubscribe = (t: string[]) => {
    for (const x of t) topics.add(x)
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'subscribe', topics: t }))
  }

  return () => { closed = true; if (retry) clearTimeout(retry); ws?.close() }
}

export const subscribe = (topics: string[]) => (globalThis as any).__grokkedSubscribe?.(topics)
