import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { VAULT_KEY_PATH } from './config.ts'
import type { Db } from './db/index.ts'

/**
 * Saved logins, encrypted at rest with AES-256-GCM. The key is a separate
 * owner-only file, so a copy of grokked.db alone reveals no passwords.
 *
 * The model never sees a secret: it lists credentials without them and asks
 * the daemon to type one into a field (see browser_fill_credential).
 */

let key: Buffer | null = null
function vaultKey(): Buffer {
  if (key) return key
  if (!existsSync(VAULT_KEY_PATH)) {
    writeFileSync(VAULT_KEY_PATH, randomBytes(32).toString('base64') + '\n', { mode: 0o600 })
  }
  key = Buffer.from(readFileSync(VAULT_KEY_PATH, 'utf8').trim(), 'base64')
  if (key.length !== 32) throw new Error(`${VAULT_KEY_PATH} is not a 32-byte key`)
  return key
}

export function encrypt(plain: string): string {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', vaultKey(), iv)
  const body = Buffer.concat([c.update(plain, 'utf8'), c.final()])
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), body.toString('base64')].join(':')
}

export function decrypt(enc: string): string {
  if (!enc) return ''
  const [v, iv, tag, body] = enc.split(':')
  if (v !== 'v1' || !iv || !tag || body === undefined) throw new Error('unrecognised secret format')
  const d = createDecipheriv('aes-256-gcm', vaultKey(), Buffer.from(iv, 'base64'))
  d.setAuthTag(Buffer.from(tag, 'base64'))
  return Buffer.concat([d.update(Buffer.from(body, 'base64')), d.final()]).toString('utf8')
}

/** "https://www.linkedin.com/login" -> "linkedin.com". Bare hosts pass through. */
export function domainOf(urlOrHost: string): string {
  const s = urlOrHost.trim().toLowerCase()
  let host = s
  try { host = new URL(s.includes('://') ? s : `https://${s}`).hostname } catch { /* keep as typed */ }
  return host.replace(/^www\./, '')
}

export const hostMatches = (host: string, domain: string) => {
  const h = host.toLowerCase().replace(/^www\./, '')
  return h === domain || h.endsWith(`.${domain}`)
}

type Row = {
  id: string; label: string; url: string; domain: string; username: string; secret_enc: string
  notes: string; bot_ids_json: string; created_at: number; updated_at: number
}

/** The shape everyone but the fill tool gets: no secret, just whether one is set. */
export interface CredentialInfo {
  id: string; label: string; url: string; domain: string; username: string
  notes: string; bot_ids: string[]; has_secret: boolean; updated_at: number
}

const info = (r: Row): CredentialInfo => ({
  id: r.id, label: r.label, url: r.url, domain: r.domain, username: r.username, notes: r.notes,
  bot_ids: JSON.parse(r.bot_ids_json || '[]'), has_secret: !!r.secret_enc, updated_at: r.updated_at,
})

const usableBy = (r: Row, botId: string) => {
  const ids = JSON.parse(r.bot_ids_json || '[]') as string[]
  return ids.length === 0 || ids.includes(botId)
}

export interface CredentialInput {
  label?: string; url?: string; domain?: string; username?: string
  password?: string; notes?: string; bot_ids?: string[]
}

export const vault = {
  list(db: Db): CredentialInfo[] {
    return (db.prepare('SELECT * FROM credentials ORDER BY label COLLATE NOCASE').all() as Row[]).map(info)
  },

  forBot(db: Db, botId: string): CredentialInfo[] {
    return (db.prepare('SELECT * FROM credentials ORDER BY label COLLATE NOCASE').all() as Row[])
      .filter((r) => usableBy(r, botId)).map(info)
  },

  create(db: Db, b: CredentialInput): CredentialInfo {
    const id = `cred_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    const domain = domainOf(b.domain || b.url || '')
    if (!domain) throw new Error('a site (url or domain) is required')
    const t = Date.now()
    db.prepare(
      `INSERT INTO credentials (id, label, url, domain, username, secret_enc, notes, bot_ids_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, b.label?.trim() || domain, b.url ?? '', domain, b.username ?? '',
          b.password ? encrypt(b.password) : '', b.notes ?? '', JSON.stringify(b.bot_ids ?? []), t, t)
    return info(db.prepare('SELECT * FROM credentials WHERE id = ?').get(id) as Row)
  },

  update(db: Db, id: string, b: CredentialInput): CredentialInfo | null {
    const r = db.prepare('SELECT * FROM credentials WHERE id = ?').get(id) as Row | undefined
    if (!r) return null
    const domain = b.domain !== undefined || b.url !== undefined ? domainOf(b.domain || b.url || '') || r.domain : r.domain
    db.prepare(
      `UPDATE credentials SET label = ?, url = ?, domain = ?, username = ?, secret_enc = ?, notes = ?,
                              bot_ids_json = ?, updated_at = ? WHERE id = ?`,
    ).run(b.label?.trim() || r.label, b.url ?? r.url, domain, b.username ?? r.username,
          b.password !== undefined ? (b.password ? encrypt(b.password) : '') : r.secret_enc,
          b.notes ?? r.notes, b.bot_ids ? JSON.stringify(b.bot_ids) : r.bot_ids_json, Date.now(), id)
    return info(db.prepare('SELECT * FROM credentials WHERE id = ?').get(id) as Row)
  },

  remove(db: Db, id: string): void {
    db.prepare('DELETE FROM credentials WHERE id = ?').run(id)
  },

  /** For the human, in Settings. */
  reveal(db: Db, id: string): string | null {
    const r = db.prepare('SELECT secret_enc FROM credentials WHERE id = ?').get(id) as { secret_enc: string } | undefined
    return r ? decrypt(r.secret_enc) : null
  },

  /** For the fill tool only: the credential if this bot may use it. */
  secretFor(db: Db, id: string, botId: string): { row: CredentialInfo; secret: string } | null {
    const r = db.prepare('SELECT * FROM credentials WHERE id = ?').get(id) as Row | undefined
    if (!r || !usableBy(r, botId)) return null
    return { row: info(r), secret: decrypt(r.secret_enc) }
  },
}
