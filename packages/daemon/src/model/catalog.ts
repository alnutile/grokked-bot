import { OPENROUTER_KEY, OPENROUTER_URL } from '../config.ts'
import { log } from '../log.ts'

/**
 * OpenRouter's tool-capable models and what each one can take. The model pickers
 * list them, and the agent loop sizes itself from them: a 1M-token model reads a
 * whole test log, a 128k one gets a trimmed version, with nothing to configure.
 * Cached for an hour; the list is large and changes slowly.
 */
export interface ModelInfo {
  id: string
  name: string
  context_length: number
  /** The longest reply the model's main provider allows; 0 when OpenRouter doesn't say. */
  max_completion_tokens: number
  prompt_per_m: number
  completion_per_m: number
}

let cache: { at: number; models: ModelInfo[]; byId: Map<string, ModelInfo> } | null = null
let inflight: Promise<ModelInfo[]> | null = null

export async function toolModels(): Promise<ModelInfo[]> {
  if (cache && Date.now() - cache.at < 3600_000) return cache.models
  inflight ??= (async () => {
    try {
      const res = await fetch(`${OPENROUTER_URL}/models?supported_parameters=tools`, {
        headers: { authorization: `Bearer ${OPENROUTER_KEY}` },
        signal: AbortSignal.timeout(10_000),
      })
      if (!res.ok) throw new Error(`OpenRouter /models answered ${res.status}`)
      const data = ((await res.json()) as any).data as any[]
      const models = data.map((m) => ({
        id: String(m.id), name: String(m.name ?? m.id), context_length: Number(m.context_length ?? 0),
        max_completion_tokens: Number(m.top_provider?.max_completion_tokens ?? 0),
        prompt_per_m: Number(m.pricing?.prompt ?? 0) * 1e6, completion_per_m: Number(m.pricing?.completion ?? 0) * 1e6,
      })).sort((a, b) => a.id.localeCompare(b.id))
      cache = { at: Date.now(), models, byId: new Map(models.map((m) => [m.id, m])) }
      return models
    } finally {
      inflight = null
    }
  })()
  return inflight
}

/** One model's details, or undefined if the list can't be fetched or doesn't have it. */
export async function modelInfo(id: string): Promise<ModelInfo | undefined> {
  try {
    await toolModels()
  } catch (e) {
    // A stale list is still right about context windows; no list at all means defaults.
    log.warn({ err: (e as Error).message }, 'model list unavailable; using default limits')
  }
  return cache?.byId.get(id)
}

export interface ModelLimits {
  /** max_tokens for each call. */
  maxTokens: number
  /** How many characters of one tool result the model is shown. */
  toolResultChars: number
}

/** What a model we know nothing about gets: safe for any current tool-capable model. */
export const DEFAULT_LIMITS: ModelLimits = { maxTokens: 8192, toolResultChars: 12_000 }

/**
 * Limits from what OpenRouter says the model can take.
 *
 * Replies: the model's own maximum, capped at 16k. OpenRouter holds back
 * max_tokens worth of credit on every call, so asking for a 128k reply from an
 * expensive model can refuse a call on a small balance; 16k is far more than one
 * step ever writes (16k of a $75/M model is a $1.20 hold).
 *
 * Tool results: about 4% of the context window each (a step usually keeps a
 * few in view next to the page and the conversation), so 128k reads ~18k
 * characters, 200k ~28k, and 1M the 60k ceiling.
 */
export function limitsFor(m: ModelInfo | undefined): ModelLimits {
  if (!m) return DEFAULT_LIMITS
  const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(n)))
  return {
    maxTokens: m.max_completion_tokens > 0 ? clamp(m.max_completion_tokens, 1024, 16_000) : DEFAULT_LIMITS.maxTokens,
    toolResultChars: m.context_length > 0 ? clamp(m.context_length * 0.04 * 3.5, 4000, 60_000) : DEFAULT_LIMITS.toolResultChars,
  }
}
