import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const xdg = (envVar: string, fallback: string) =>
  process.env[envVar] && process.env[envVar]!.startsWith('/')
    ? process.env[envVar]!
    : join(homedir(), fallback)

export const VERSION = '0.1.0'
export const INSTANCE_ID = `inst_${randomUUID().replaceAll('-', '').slice(0, 16)}`

export const CONFIG_DIR = join(xdg('XDG_CONFIG_HOME', '.config'), 'grokked')
export const DATA_DIR = join(xdg('XDG_DATA_HOME', '.local/share'), 'grokked')
export const RUNTIME_DIR = join(process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 1000}`, 'grokked')

export const DB_PATH = process.env.GROKKED_DB ?? join(DATA_DIR, 'grokked.db')
export const BLOB_DIR = join(DATA_DIR, 'blobs')
export const TOKEN_PATH = join(CONFIG_DIR, 'token')
export const DISCOVERY_PATH = join(RUNTIME_DIR, 'daemon.json')

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
