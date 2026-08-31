import { OPENROUTER_KEY, OPENROUTER_URL } from '../config.ts'
import { log } from '../log.ts'

/* OpenRouter is plain OpenAI-shaped HTTP. There is no SDK worth wrapping, and
   pretending otherwise buys nothing -- so these types mirror the wire format. */

export interface ToolDef {
  type: 'function'
  function: { name: string; description: string; parameters: unknown }
}

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | ContentPart[] | null
  tool_calls?: ToolCall[]
  tool_call_id?: string
  name?: string
}

export interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface Usage {
  prompt_tokens: number
  completion_tokens: number
  cost?: number
  is_byok?: boolean
  cost_details?: { upstream_inference_cost?: number }
  prompt_tokens_details?: { cached_tokens?: number }
  completion_tokens_details?: { reasoning_tokens?: number }
}

/**
 * On a BYOK key OpenRouter reports cost: 0 -- they are not billing credits, so
 * from their side it is free -- and the real spend shows up under
 * cost_details.upstream_inference_cost. Reading `cost` alone silently reports
 * $0.00 for every call, which would quietly disable every budget cap in the
 * system. Always take the larger of the two.
 */
export function effectiveCost(u: Usage): number {
  return Math.max(u.cost ?? 0, u.cost_details?.upstream_inference_cost ?? 0)
}

export interface ChatResult {
  id: string
  model: string
  provider?: string
  content: string | null
  tool_calls: ToolCall[]
  finish_reason: string
  usage: Usage
  /** Real dollars, BYOK-aware. Use this, not usage.cost. */
  cost_usd: number
  latency_ms: number
}

export class ModelError extends Error {
  status: number | undefined
  retryable: boolean
  constructor(message: string, status?: number, retryable = false) {
    super(message)
    this.status = status
    this.retryable = retryable
  }
}

export interface ChatRequest {
  model: string
  messages: ChatMessage[]
  tools?: ToolDef[]
  fallbacks?: string[]
  temperature?: number
  max_tokens?: number
}

export async function chat(req: ChatRequest, signal?: AbortSignal): Promise<ChatResult> {
  if (!OPENROUTER_KEY) throw new ModelError('OPENROUTER_API_KEY is not set')

  const body: Record<string, unknown> = {
    model: req.model,
    messages: req.messages,
    // Concurrent UI actions are a race condition, not a speedup.
    parallel_tool_calls: false,
    // Ask OpenRouter for real token counts and real cost rather than computing
    // an estimate from a price table that would silently drift.
    usage: { include: true },
    temperature: req.temperature ?? 0.2,
    max_tokens: req.max_tokens ?? 4096,
  }
  if (req.tools?.length) {
    body.tools = req.tools
    body.tool_choice = 'auto'
    // NOT provider.require_parameters: combined with parallel_tool_calls it makes
    // OpenRouter reject every Anthropic endpoint with a hard 404 ("no endpoints
    // found"), because none of them advertise parallel_tool_calls. Tool support is
    // instead guaranteed by validateModels() on boot, and a response that comes
    // back with no tool_calls is handled by the loop's nudge path.
  }
  if (req.fallbacks?.length) body.models = [req.model, ...req.fallbacks]

  const started = Date.now()
  const res = await fetch(`${OPENROUTER_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${OPENROUTER_KEY}`,
      'content-type': 'application/json',
      'HTTP-Referer': 'https://github.com/alnutile/grokked-bot',
      'X-Title': 'Grokked Bot',
    },
    body: JSON.stringify(body),
    signal: signal ?? null,
  }).catch((e: Error) => {
    throw new ModelError(`network: ${e.message}`, undefined, true)
  })

  const text = await res.text()
  if (!res.ok) {
    throw new ModelError(
      `openrouter ${res.status}: ${text.slice(0, 400)}`,
      res.status,
      res.status === 429 || res.status >= 500,
    )
  }

  let json: any
  try { json = JSON.parse(text) } catch { throw new ModelError(`bad JSON: ${text.slice(0, 200)}`) }
  if (json.error) throw new ModelError(`openrouter: ${json.error.message ?? JSON.stringify(json.error)}`)

  const choice = json.choices?.[0]
  if (!choice) throw new ModelError(`no choices: ${text.slice(0, 200)}`)

  const usage: Usage = json.usage ?? { prompt_tokens: 0, completion_tokens: 0 }
  return {
    id: json.id,
    model: json.model ?? req.model,
    provider: json.provider,
    content: choice.message?.content ?? null,
    tool_calls: choice.message?.tool_calls ?? [],
    finish_reason: choice.finish_reason ?? 'unknown',
    usage,
    cost_usd: effectiveCost(usage),
    latency_ms: Date.now() - started,
  }
}

/** Loud warning on boot beats a 404 during an unattended 3am run. */
export async function validateModels(ids: string[]): Promise<void> {
  try {
    const res = await fetch(`${OPENROUTER_URL}/models?supported_parameters=tools`, {
      headers: { authorization: `Bearer ${OPENROUTER_KEY}` },
    })
    if (!res.ok) return
    const known = new Set(((await res.json()) as any).data.map((m: any) => m.id as string))
    for (const id of new Set(ids)) {
      if (!known.has(id)) log.warn({ model: id }, 'configured model is not a tool-capable OpenRouter model')
    }
  } catch (e) {
    log.warn({ err: (e as Error).message }, 'could not validate model ids')
  }
}

export interface Credits {
  total_credits: number
  total_usage: number
  remaining: number
}

/** The real spending constraint. A local per-run cap is a guardrail against
 *  runaway loops, not a budget -- this is the budget. */
export async function credits(): Promise<Credits | null> {
  try {
    const res = await fetch(`${OPENROUTER_URL}/credits`, {
      headers: { authorization: `Bearer ${OPENROUTER_KEY}` },
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return null
    const d = ((await res.json()) as any).data ?? {}
    const total = Number(d.total_credits ?? 0)
    const used = Number(d.total_usage ?? 0)
    return { total_credits: total, total_usage: used, remaining: total - used }
  } catch {
    return null
  }
}
