import type { Db } from './db/index.ts'
import { decrypt, encrypt } from './vault.ts'

/**
 * A bot's environment variables: pasted in as a .env file, kept encrypted with
 * the vault key, and handed to the shim on every run_bash. Nothing is written
 * to the bot's disk, so a variable removed here is gone from the next command.
 *
 * The model is told the names, never the values. Values that look like secrets
 * are masked in everything the bot's tools return (see redactEnv), so `env` or
 * a verbose curl can't echo a token back into the transcript.
 */

export interface EnvVar { key: string; value: string }

const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/

/** The shim and the desktop depend on these; overriding one breaks the computer, not just the command. */
export const RESERVED = new Set([
  'HOME', 'PATH', 'USER', 'SHELL', 'PWD', 'DISPLAY', 'TERM',
  'WORK_DIR', 'PROFILE_DIR', 'CDP_PORT', 'SHIM_PORT', 'SHIM_TOKEN',
])

/** Named like a secret, or long enough to be a token. "production" and "1" stay readable. */
const SECRET_NAME = /TOKEN|KEY|SECRET|PASS|PWD|AUTH|CREDENTIAL|PRIVATE|SESSION|COOKIE|DSN/i
export const looksSecret = (v: EnvVar) => v.value.length >= 4 && (SECRET_NAME.test(v.key) || v.value.length >= 16)

/**
 * Reads a .env file the way people actually write them: `export` prefixes,
 * comments, single quotes (literal), double quotes (with \n escapes, and may
 * span lines) and unquoted values with a trailing `# comment`. Later keys win.
 */
export function parseDotenv(text: string): { vars: EnvVar[]; skipped: string[] } {
  const out = new Map<string, string>()
  const skipped: string[] = []
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim()
    if (!line || line.startsWith('#')) continue
    const m = /^(?:export\s+)?([^=\s]+)\s*=\s*(.*)$/.exec(line)
    if (!m) { skipped.push(line.length > 40 ? `${line.slice(0, 40)}…` : line); continue }
    const key = m[1]!
    let raw = m[2]!
    if (!KEY.test(key)) { skipped.push(`${key} (not a valid name)`); continue }
    if (RESERVED.has(key)) { skipped.push(`${key} (the bot's computer needs its own)`); continue }

    let value: string
    const q = raw[0]
    if (q === '"' || q === "'") {
      // A quoted value runs to its closing quote, which may be on a later line.
      let body = raw.slice(1)
      while (!closes(body, q) && i + 1 < lines.length) body += '\n' + lines[++i]
      const end = closeAt(body, q)
      value = end < 0 ? body : body.slice(0, end)
      if (q === '"') value = value.replace(/\\(.)/g, (_, c: string) => (c === 'n' ? '\n' : c === 't' ? '\t' : c))
    } else {
      value = raw.replace(/\s+#.*$/, '').trim()
    }
    out.set(key, value)
  }
  return { vars: [...out].map(([key, value]) => ({ key, value })), skipped }
}

const closeAt = (s: string, q: string) => {
  for (let i = 0; i < s.length; i++) {
    if (q === '"' && s[i] === '\\') { i++; continue }
    if (s[i] === q) return i
  }
  return -1
}
const closes = (s: string, q: string) => closeAt(s, q) >= 0

/** Shown as a file again for editing: values quoted only when they need it. */
export function toDotenv(vars: EnvVar[]): string {
  return vars.map(({ key, value }) =>
    /^[A-Za-z0-9_./:@%+,-]*$/.test(value)
      ? `${key}=${value}`
      : `${key}="${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`,
  ).join('\n')
}

export const botEnv = {
  get(db: Db, botId: string): EnvVar[] {
    const r = db.prepare('SELECT env_enc FROM bots WHERE id = ?').get(botId) as { env_enc: string } | undefined
    if (!r?.env_enc) return []
    return JSON.parse(decrypt(r.env_enc)) as EnvVar[]
  },

  /** Replaces the whole set. Invalid and reserved names are dropped, not stored. */
  set(db: Db, botId: string, vars: EnvVar[]): { vars: EnvVar[]; skipped: string[] } {
    const clean = new Map<string, string>()
    const skipped: string[] = []
    for (const v of vars) {
      const key = String(v.key ?? '').trim()
      if (!KEY.test(key)) { if (key) skipped.push(`${key} (not a valid name)`); continue }
      if (RESERVED.has(key)) { skipped.push(`${key} (the bot's computer needs its own)`); continue }
      clean.set(key, String(v.value ?? ''))
    }
    const list = [...clean].map(([key, value]) => ({ key, value }))
    db.prepare('UPDATE bots SET env_enc = ?, updated_at = ? WHERE id = ?')
      .run(list.length ? encrypt(JSON.stringify(list)) : '', Date.now(), botId)
    return { vars: list, skipped }
  },

  keys(db: Db, botId: string): string[] {
    return botEnv.get(db, botId).map((v) => v.key)
  },

  /**
   * What the shim merges into the shell. A GitHub token also gets a git
   * credential helper, so `git clone https://github.com/owner/private-repo`
   * works with no token in the URL (and so none in the transcript), and `gh`
   * finds it as GH_TOKEN.
   */
  forShell(db: Db, botId: string): Record<string, string> {
    const env = Object.fromEntries(botEnv.get(db, botId).map((v) => [v.key, v.value]))
    // Commits need a name and email or git refuses. The bot's own name unless the
    // human set GIT_AUTHOR_NAME / GIT_AUTHOR_EMAIL (e.g. to their own, so commits
    // link to their GitHub account).
    const bot = db.prepare('SELECT name FROM bots WHERE id = ?').get(botId) as { name: string } | undefined
    env.GIT_AUTHOR_NAME ||= bot?.name || 'Grokked Bot'
    env.GIT_AUTHOR_EMAIL ||= `${botId}@grokked-bot.local`
    env.GIT_COMMITTER_NAME ||= env.GIT_AUTHOR_NAME
    env.GIT_COMMITTER_EMAIL ||= env.GIT_AUTHOR_EMAIL
    const gh = env.GH_TOKEN || env.GITHUB_TOKEN
    if (gh) {
      env.GH_TOKEN ??= gh
      env.GITHUB_TOKEN ??= gh
      if (!env.GIT_CONFIG_COUNT) {
        // The helper reads the variable when git runs it, so the value is never in git's config.
        Object.assign(env, {
          GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: 'credential.https://github.com.helper',
          GIT_CONFIG_VALUE_0: '!f() { test "$1" = get && echo username=x-access-token && echo "password=$GH_TOKEN"; }; f',
        })
      }
    }
    return env
  },
}

/** Masks secret-looking values anywhere in a tool result, naming the variable instead. */
export function redactEnv<T>(out: T, vars: EnvVar[]): T {
  const secrets = vars.filter(looksSecret).sort((a, b) => b.value.length - a.value.length)
  if (!secrets.length) return out
  const scrub = (s: string) => secrets.reduce((acc, v) => acc.replaceAll(v.value, `[$${v.key}]`), s)
  const walk = (x: unknown): unknown =>
    typeof x === 'string' ? scrub(x)
      : Array.isArray(x) ? x.map(walk)
        : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, walk(v)]))
          : x
  return walk(out) as T
}
