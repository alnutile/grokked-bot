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
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
  return (await res.json()) as T
}

export interface Bot {
  id: string; name: string; persona_md: string
  autonomy: string; status: string; created_at: number
}
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
  createRun: (bot_id: string, goal: string, allowed_domains: string[], max_usd?: number) =>
    req<{ run: Run }>('/v1/runs', {
      method: 'POST',
      body: JSON.stringify({ bot_id, goal, allowed_domains, ...(max_usd ? { max_usd } : {}) }),
    }).then((r) => r.run),
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
