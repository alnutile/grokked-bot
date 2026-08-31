import type { Db } from '../db/index.ts'
import type { Tool } from '../tools/registry.ts'

export type Decision = 'allow' | 'approve' | 'deny'

/** Words that mean "this changes the world", matched against the model's own
 *  plain-language description of what it is clicking. */
const DESTRUCTIVE =
  /\b(send|submit|pay|purchase|buy|checkout|delete|remove|destroy|transfer|confirm|publish|deploy|share|invite|revoke|approve|cancel subscription|unsubscribe)\b/i

/** Shell that is hard to undo or reaches off the machine in bulk. */
const DANGEROUS_BASH = [
  /\brm\s+-[a-z]*r[a-z]*f?\b/i,
  /\bmkfs\b|\bdd\s+if=/i,
  /\bcurl\b[^|]*\|\s*(ba)?sh\b/i,
  /\bwget\b[^|]*\|\s*(ba)?sh\b/i,
  /\bgit\s+push\b/i,
  /\b(shutdown|reboot|halt)\b/i,
  /\bchmod\s+777\s+\//,
  />\s*\/etc\//,
]

export interface PolicyResult {
  decision: Decision
  reason: string
  /** True when no "remember this" shortcut may bypass it. */
  locked: boolean
}

/**
 * Gate on the ACTION, never on the model's stated intent. A hostile page can talk
 * the model into saying anything, but it cannot change the tool name or the
 * arguments this function inspects.
 */
export function evaluatePolicy(db: Db, botId: string, tool: Tool, args: any): PolicyResult {
  // High risk is never delegable, regardless of any stored policy.
  if (tool.risk === 'high' || tool.approval === 'always') {
    return { decision: 'approve', reason: `${tool.name} is high risk`, locked: true }
  }

  const row = db
    .prepare('SELECT mode, condition_json FROM tool_policies WHERE bot_id = ? AND tool_name = ?')
    .get(botId, tool.name) as { mode: Decision; condition_json: string | null } | undefined
  if (row && matches(row.condition_json, args)) {
    return { decision: row.mode, reason: 'stored policy', locked: false }
  }

  if (tool.name === 'run_bash') {
    const cmd = String(args?.command ?? '')
    const hit = DANGEROUS_BASH.find((re) => re.test(cmd))
    if (hit) return { decision: 'approve', reason: `command matches ${hit}`, locked: true }
  }

  if (tool.name === 'browser_click' && DESTRUCTIVE.test(String(args?.element ?? ''))) {
    return { decision: 'approve', reason: `clicking "${args.element}" looks irreversible`, locked: false }
  }

  if (tool.name === 'browser_type' && /password|card|cvv|ssn|account number|routing/i.test(String(args?.element ?? ''))) {
    return { decision: 'approve', reason: 'typing into a sensitive field', locked: true }
  }

  if (tool.name === 'write_file' && !String(args?.path ?? '').startsWith('/data/work')) {
    return { decision: 'deny', reason: 'writes are confined to /data/work', locked: true }
  }

  return { decision: 'allow', reason: '', locked: false }
}

function matches(conditionJson: string | null, args: any): boolean {
  if (!conditionJson) return true
  try {
    const cond = JSON.parse(conditionJson) as Record<string, { gt?: number; lt?: number; eq?: unknown }>
    return Object.entries(cond).every(([k, c]) => {
      const v = args?.[k]
      if (c.gt !== undefined) return typeof v === 'number' && v > c.gt
      if (c.lt !== undefined) return typeof v === 'number' && v < c.lt
      if (c.eq !== undefined) return v === c.eq
      return true
    })
  } catch { return false }
}

/** What the human sees before deciding. Approving raw JSON is a rubber stamp. */
export function renderPreview(tool: Tool, args: any): { title: string; detail: string } {
  switch (tool.name) {
    case 'browser_click':
      return { title: `Click "${args.element}"`, detail: `A click the bot judged irreversible.` }
    case 'browser_type':
      return { title: `Type into "${args.element}"`, detail: String(args.text ?? '').slice(0, 200) }
    case 'run_bash':
      return { title: 'Run a shell command', detail: String(args.command ?? '').slice(0, 800) }
    case 'desktop_action':
      return {
        title: `Desktop ${args.action}`,
        detail: `${args.reason ?? 'no reason given'}\n\nat (${args.x ?? '?'}, ${args.y ?? '?'})` +
                `${args.keys ? `\nkeys: ${args.keys}` : ''}${args.text ? `\ntext: ${args.text}` : ''}`,
      }
    default:
      return { title: tool.name, detail: JSON.stringify(args, null, 2).slice(0, 800) }
  }
}
