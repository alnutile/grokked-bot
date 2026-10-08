import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const IS_MAC = process.platform === 'darwin'

const xdg = (envVar: string, fallback: string) =>
  process.env[envVar] && process.env[envVar]!.startsWith('/')
    ? process.env[envVar]!
    : join(homedir(), fallback)

export const VERSION = '0.2.1'
export const INSTANCE_ID = `inst_${randomUUID().replaceAll('-', '').slice(0, 16)}`

// macOS has no XDG dirs and no /run/user. Everything lives under Application
// Support there; the desktop app reads the token from the same place, so keep
// these in sync with apps/desktop/src-tauri/src/lib.rs.
const MAC_DIR = join(homedir(), 'Library', 'Application Support', 'Grokked')

// The packaged Linux app runs as its own instance beside a dev setup, so the
// desktop app can point all three somewhere else (see Instance in lib.rs).
export const CONFIG_DIR = process.env.GROKKED_CONFIG_DIR
  ?? (IS_MAC ? MAC_DIR : join(xdg('XDG_CONFIG_HOME', '.config'), 'grokked'))
export const DATA_DIR = process.env.GROKKED_DATA_DIR
  ?? (IS_MAC ? MAC_DIR : join(xdg('XDG_DATA_HOME', '.local/share'), 'grokked'))
export const RUNTIME_DIR = process.env.GROKKED_RUNTIME_DIR ?? (IS_MAC
  ? join(MAC_DIR, 'run')
  : join(process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 1000}`, 'grokked'))

export const DB_PATH = process.env.GROKKED_DB ?? join(DATA_DIR, 'grokked.db')
export const BLOB_DIR = join(DATA_DIR, 'blobs')
export const TOKEN_PATH = join(CONFIG_DIR, 'token')
export const DISCOVERY_PATH = join(RUNTIME_DIR, 'daemon.json')

export const ENV_PATH = join(CONFIG_DIR, 'env')

// systemd loads the env file for us on Linux. When the desktop app launches the
// daemon on macOS nothing does, so read it here. Values already in the
// environment win.
if (existsSync(ENV_PATH)) {
  try { process.loadEnvFile(ENV_PATH) } catch { /* malformed: fall through to the setup screen */ }
}

export let OPENROUTER_KEY = process.env.OPENROUTER_API_KEY ?? ''
export const OPENROUTER_URL = process.env.OPENROUTER_URL ?? 'https://openrouter.ai/api/v1'

/** Set from the app's setup screen. Persisted to the env file so systemd (Linux)
 *  and the app-launched daemon (macOS) both pick it up on the next start. */
export function setOpenRouterKey(key: string): void {
  OPENROUTER_KEY = key
  process.env.OPENROUTER_API_KEY = key
  const lines = existsSync(ENV_PATH)
    ? readFileSync(ENV_PATH, 'utf8').split('\n').filter((l) => l && !l.startsWith('OPENROUTER_API_KEY='))
    : []
  lines.push(`OPENROUTER_API_KEY=${key}`)
  writeFileSync(ENV_PATH, lines.join('\n') + '\n', { mode: 0o600 })
}

/** Rootless Docker on Linux when it's there. Otherwise leave it unset so the
 *  docker CLI uses its current context: Docker Desktop, OrbStack and Colima on
 *  macOS, or plain /var/run/docker.sock on Linux. */
const ROOTLESS_SOCK = `/run/user/${process.getuid?.() ?? 1000}/docker.sock`
export const DOCKER_HOST_SOCK: string | undefined =
  process.env.DOCKER_HOST ?? (!IS_MAC && existsSync(ROOTLESS_SOCK) ? `unix://${ROOTLESS_SOCK}` : undefined)

/** The bot's computer. Pulled from the registry on first run; on Linux you can
 *  still build it locally with container/build.sh and point this at the tag. */
/** The packaged app passes its version so it runs the bot computer image built
 *  for that release (ghcr …:<version>). An upgrade then finds that tag missing,
 *  the setup screen pulls it, and bot computers are recreated on it (logins are
 *  in volumes, so they survive). A fixed tag never reached existing installs:
 *  they kept their cached copy forever. */
const APP_VERSION = process.env.GROKKED_APP_VERSION
export const COMPUTER_IMAGE = process.env.GROKKED_IMAGE ??
  `ghcr.io/alnutile/grokked-computer:${APP_VERSION && /^\d+\.\d+\.\d+$/.test(APP_VERSION) ? APP_VERSION : '0.1'}`
/** Prefix for bot computer container (and profile volume) names. Containers are
 *  named after the bot, so a second instance on the same machine -- the test
 *  instance next to the installed app -- needs its own prefix or it would drive
 *  the real instance's bots' computers. */
export const CONTAINER_PREFIX = process.env.GROKKED_CONTAINER_PREFIX ?? ''

export interface ModelRoles {
  planner: string
  worker: string
  vision: string
  distiller: string
  classifier: string
}

/** Never hard-code model ids in source: they churn. Validated against
 *  GET /models on boot so a bad id is a loud warning, not a 3am 404. */
export const DEFAULT_MODELS: ModelRoles = {
  planner: 'anthropic/claude-opus-4.8',
  worker: 'anthropic/claude-sonnet-5',
  vision: 'anthropic/claude-sonnet-5',
  distiller: 'google/gemini-2.5-flash-lite',
  classifier: 'google/gemini-2.5-flash-lite',
}

export interface Config {
  models: ModelRoles
  defaults: { max_steps: number; max_usd: number; max_wall_s: number; max_screenshots: number }
}

export function loadConfig(): Config {
  const path = join(CONFIG_DIR, 'config.json')
  const base: Config = {
    models: DEFAULT_MODELS,
    defaults: { max_steps: 40, max_usd: 10.0, max_wall_s: 3600, max_screenshots: 12 },
  }
  if (!existsSync(path)) {
    writeFileSync(path, JSON.stringify(base, null, 2) + '\n', { mode: 0o600 })
    return base
  }
  try {
    const user = JSON.parse(readFileSync(path, 'utf8')) as Partial<Config>
    return {
      models: { ...base.models, ...(user.models ?? {}) },
      defaults: { ...base.defaults, ...(user.defaults ?? {}) },
    }
  } catch {
    return base
  }
}

/** Merge a change into config.json. The loop reads config every step, so a new
 *  model or cap applies from the next step on, no restart. */
export function saveConfig(patch: { models?: Partial<ModelRoles>; defaults?: Partial<Config['defaults']> }): Config {
  const cur = loadConfig()
  const next: Config = {
    models: { ...cur.models, ...(patch.models ?? {}) },
    defaults: { ...cur.defaults, ...(patch.defaults ?? {}) },
  }
  writeFileSync(join(CONFIG_DIR, 'config.json'), JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
  return next
}

/** The vault's encryption key: 32 random bytes, owner-only, made on first use. */
export const VAULT_KEY_PATH = join(CONFIG_DIR, 'vault.key')

/** The webhook listener: only /hooks routes, nothing else of the API. This is
 *  what Tailscale (or any tunnel you prefer) exposes; the main API never is. */
export const HOOKS_HOST = process.env.GROKKED_HOOKS_HOST ?? '127.0.0.1'
export const HOOKS_PORT = Number(process.env.GROKKED_HOOKS_PORT ?? 8788)

export const HOST = process.env.GROKKED_HOST ?? '127.0.0.1'
export const PORT = Number(process.env.GROKKED_PORT ?? 8787)

/** Events older than this are pruned; a client asking for `since` beyond it
 *  gets hello{dropped:true} and must do a full refetch. */
export const EVENT_RETENTION_MS = 48 * 60 * 60 * 1000

export function ensureDirs(): void {
  for (const d of [CONFIG_DIR, DATA_DIR, BLOB_DIR, RUNTIME_DIR]) {
    mkdirSync(d, { recursive: true, mode: 0o700 })
  }
}

/** Generated on first boot. Not because loopback needs it, but so that moving
 *  to a remote host later is a config change and not a scramble to add auth. */
export function loadOrCreateToken(): string {
  if (existsSync(TOKEN_PATH)) return readFileSync(TOKEN_PATH, 'utf8').trim()
  const token = randomBytes(32).toString('base64url')
  writeFileSync(TOKEN_PATH, token + '\n', { mode: 0o600 })
  return token
}
