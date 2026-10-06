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

/** Single sign-on providers a site's login can defer to. */
export const PROVIDERS: Record<string, string> = {
  google: 'Google', microsoft: 'Microsoft', apple: 'Apple', github: 'GitHub',
}

type Row = {
  id: string; label: string; url: string; domain: string; username: string; secret_enc: string
  notes: string; bot_ids_json: string; created_at: number; updated_at: number
  sign_in_with: string; via_credential_id: string
}

/** The shape everyone but the fill tool gets: no secret, just whether one is set. */
export interface CredentialInfo {
  id: string; label: string; url: string; domain: string; username: string
  notes: string; bot_ids: string[]; has_secret: boolean; updated_at: number
  /** '' = its own username and password; otherwise the SSO provider it uses. */
  sign_in_with: string
  /** The saved provider account (another credential) used to sign in. */
  via_credential_id: string
}

const info = (r: Row): CredentialInfo => ({
  id: r.id, label: r.label, url: r.url, domain: r.domain, username: r.username, notes: r.notes,
  bot_ids: JSON.parse(r.bot_ids_json || '[]'), has_secret: !!r.secret_enc, updated_at: r.updated_at,
  sign_in_with: r.sign_in_with, via_credential_id: r.via_credential_id,
})

const usableBy = (r: Row, botId: string) => {
  const ids = JSON.parse(r.bot_ids_json || '[]') as string[]
  return ids.length === 0 || ids.includes(botId)
}

export interface CredentialInput {
  label?: string; url?: string; domain?: string; username?: string
  password?: string; notes?: string; bot_ids?: string[]
  sign_in_with?: string; via_credential_id?: string
}

function checkSso(b: CredentialInput): void {
  if (b.sign_in_with && !PROVIDERS[b.sign_in_with]) throw new Error(`unknown sign-in provider: ${b.sign_in_with}`)
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
    checkSso(b)
    const sso = b.sign_in_with ?? ''
    const t = Date.now()
    db.prepare(
      `INSERT INTO credentials (id, label, url, domain, username, secret_enc, notes, bot_ids_json,
                                sign_in_with, via_credential_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, b.label?.trim() || domain, b.url ?? '', domain, sso ? '' : b.username ?? '',
          !sso && b.password ? encrypt(b.password) : '', b.notes ?? '', JSON.stringify(b.bot_ids ?? []),
          sso, sso ? b.via_credential_id ?? '' : '', t, t)
    return info(db.prepare('SELECT * FROM credentials WHERE id = ?').get(id) as Row)
  },

  update(db: Db, id: string, b: CredentialInput): CredentialInfo | null {
    const r = db.prepare('SELECT * FROM credentials WHERE id = ?').get(id) as Row | undefined
    if (!r) return null
    const domain = b.domain !== undefined || b.url !== undefined ? domainOf(b.domain || b.url || '') || r.domain : r.domain
    checkSso(b)
    const sso = b.sign_in_with ?? r.sign_in_with
    // Switching to SSO drops the site's own username and password: it has none.
    db.prepare(
      `UPDATE credentials SET label = ?, url = ?, domain = ?, username = ?, secret_enc = ?, notes = ?,
                              bot_ids_json = ?, sign_in_with = ?, via_credential_id = ?, updated_at = ? WHERE id = ?`,
    ).run(b.label?.trim() || r.label, b.url ?? r.url, domain, sso ? '' : b.username ?? r.username,
          sso ? '' : b.password !== undefined ? (b.password ? encrypt(b.password) : '') : r.secret_enc,
          b.notes ?? r.notes, b.bot_ids ? JSON.stringify(b.bot_ids) : r.bot_ids_json,
          sso, sso ? b.via_credential_id ?? r.via_credential_id : '', Date.now(), id)
    return info(db.prepare('SELECT * FROM credentials WHERE id = ?').get(id) as Row)
  },

  remove(db: Db, id: string): void {
    db.prepare('DELETE FROM credentials WHERE id = ?').run(id)
    // Sites that signed in through this account keep their SSO choice but lose the link.
    db.prepare(`UPDATE credentials SET via_credential_id = '' WHERE via_credential_id = ?`).run(id)
  },

  /**
   * What the bot gets from credentials_list: no secrets, and for each login the
   * exact steps to sign in. The procedure lives here, next to the data, so the
   * bot reads it at the moment it needs it.
   */
  forBotWithSteps(db: Db, botId: string) {
    const mine = vault.forBot(db, botId)
    const byId = new Map(mine.map((c) => [c.id, c]))
    return mine.map((c) => {
      const base = { id: c.id, label: c.label, site: c.domain, url: c.url || undefined, notes: c.notes || undefined }
      if (!c.sign_in_with) {
        return {
          ...base, username: c.username || undefined, has_password: c.has_secret,
          how_to_sign_in: `On ${c.domain}'s sign-in page, browser_fill_credential(${c.id}, username) into the email/username ` +
            `field and (${c.id}, password) into the password field, then click its sign-in button. If the password ` +
            'field only appears after you submit the username, snapshot again before filling it.',
        }
      }
      const provider = PROVIDERS[c.sign_in_with] ?? c.sign_in_with
      const via = byId.get(c.via_credential_id)
      return {
        ...base, sign_in_with: provider,
        provider_account: via ? { id: via.id, label: via.label, site: via.domain, username: via.username || undefined } : undefined,
        how_to_sign_in: via
          ? `${c.domain} has no password of its own: sign in with ${provider}. On its sign-in page click the ` +
            `"Continue with ${provider}" / "Sign in with ${provider}" button (it may open a new window — you are moved ` +
            `into it automatically). On ${via.domain}: if ${via.username || 'the account'} is listed, click it; otherwise ` +
            `browser_fill_credential(${via.id}, username), click Next, snapshot, then browser_fill_credential(${via.id}, password) ` +
            `and click Next. Approve any consent screen for ${c.domain} only if it is what was asked. If ${provider} asks ` +
            'for a code, a phone prompt or a CAPTCHA, call ask_human.'
          : `${c.domain} signs in with ${provider}, but no ${provider} account is saved for you. Click the ` +
            `${provider} button; if you are not already signed in to ${provider}, call ask_human.`,
      }
    })
  },

  /** For the human, in Settings. */
  reveal(db: Db, id: string): string | null {
    const r = db.prepare('SELECT secret_enc FROM credentials WHERE id = ?').get(id) as { secret_enc: string } | undefined
    return r ? decrypt(r.secret_enc) : null
  },

  /** For the fill tool: the site login this one is the provider account for, if any. */
  ssoSiteFor(db: Db, id: string): CredentialInfo | null {
    const r = db.prepare(`SELECT * FROM credentials WHERE id = ? AND sign_in_with != ''`).get(id) as Row | undefined
    return r ? info(r) : null
  },

  /** For the fill tool only: the credential if this bot may use it. */
  secretFor(db: Db, id: string, botId: string): { row: CredentialInfo; secret: string } | null {
    const r = db.prepare('SELECT * FROM credentials WHERE id = ?').get(id) as Row | undefined
    if (!r || !usableBy(r, botId)) return null
    return { row: info(r), secret: decrypt(r.secret_enc) }
  },
}
