import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto'
import type { Db } from './db/index.ts'
import { decrypt, encrypt } from './vault.ts'

/**
 * A bot's SSH identity: its own ed25519 key, so a server can let one bot in (and
 * shut it out) without touching anyone else's access. The private key is kept
 * encrypted with the vault key and handed to the shim with each run_bash, which
 * loads it into an ssh-agent. It is never written to the bot's disk, so the model
 * can use `ssh` and `scp` but can't print the key.
 *
 * Servers are the human's list of what the bot may log in to, so "check the disk
 * on the web server" means something.
 */

export interface SshHost { name: string; target: string; port?: number; note?: string }
export interface SshInfo { public_key: string; fingerprint: string; created_at: number | null; hosts: SshHost[] }

const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b }
const str = (b: Buffer | string) => { const x = Buffer.from(b); return Buffer.concat([u32(x.length), x]) }
const wrap = (s: string, n = 70) => s.match(new RegExp(`.{1,${n}}`, 'g'))!.join('\n')

/** A fresh ed25519 pair in OpenSSH's own formats (what ssh-keygen would write). */
export function generateKey(comment: string): { privateKey: string; publicKey: string } {
  const { privateKey } = generateKeyPairSync('ed25519')
  const jwk = privateKey.export({ format: 'jwk' }) as { d: string; x: string }
  const seed = Buffer.from(jwk.d, 'base64url')
  const pub = Buffer.from(jwk.x, 'base64url')
  const pubBlob = Buffer.concat([str('ssh-ed25519'), str(pub)])

  const check = randomBytes(4)
  let priv = Buffer.concat([check, check, str('ssh-ed25519'), str(pub), str(Buffer.concat([seed, pub])), str(comment)])
  const pad = (8 - (priv.length % 8)) % 8
  priv = Buffer.concat([priv, Buffer.from(Array.from({ length: pad }, (_, i) => i + 1))])

  const body = Buffer.concat([
    Buffer.from('openssh-key-v1\0'), str('none'), str('none'), str(''), u32(1), str(pubBlob), str(priv),
  ])
  return {
    privateKey: `-----BEGIN OPENSSH PRIVATE KEY-----\n${wrap(body.toString('base64'))}\n-----END OPENSSH PRIVATE KEY-----\n`,
    publicKey: `ssh-ed25519 ${pubBlob.toString('base64')} ${comment}`,
  }
}

/** SHA256:… as `ssh-keygen -l` and servers' auth logs show it. */
export function fingerprint(publicKey: string): string {
  const b64 = publicKey.split(/\s+/)[1] ?? ''
  return `SHA256:${createHash('sha256').update(Buffer.from(b64, 'base64')).digest('base64').replace(/=+$/, '')}`
}

const TARGET = /^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9.-]+$|^(?:[A-Za-z0-9._-]+@)?\[[0-9a-fA-F:.]+\]$/

/** Drops rows without a usable user@host; trims the rest. */
export function cleanHosts(hosts: unknown): SshHost[] {
  if (!Array.isArray(hosts)) return []
  const out: SshHost[] = []
  for (const h of hosts as Array<Record<string, unknown>>) {
    const target = String(h?.target ?? '').trim()
    if (!TARGET.test(target)) continue
    const port = Number(h?.port)
    out.push({
      name: String(h?.name ?? '').trim().slice(0, 60) || target,
      target,
      ...(Number.isInteger(port) && port > 0 && port < 65536 && port !== 22 ? { port } : {}),
      ...(String(h?.note ?? '').trim() ? { note: String(h.note).trim().slice(0, 300) } : {}),
    })
  }
  return out
}

type Row = { name: string; ssh_key_enc: string; ssh_public: string; ssh_created_at: number | null; ssh_hosts_json: string }
const row = (db: Db, botId: string) =>
  db.prepare('SELECT name, ssh_key_enc, ssh_public, ssh_created_at, ssh_hosts_json FROM bots WHERE id = ?').get(botId) as Row | undefined

export const botSsh = {
  info(db: Db, botId: string): SshInfo | null {
    const r = row(db, botId)
    if (!r) return null
    return {
      public_key: r.ssh_public,
      fingerprint: r.ssh_public ? fingerprint(r.ssh_public) : '',
      created_at: r.ssh_created_at,
      hosts: JSON.parse(r.ssh_hosts_json || '[]') as SshHost[],
    }
  },

  /** Makes the bot's key, replacing any old one (which then stops working everywhere). */
  rotate(db: Db, botId: string): SshInfo | null {
    const r = row(db, botId)
    if (!r) return null
    const slug = r.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'bot'
    const k = generateKey(`grokked-${slug}`)
    db.prepare('UPDATE bots SET ssh_key_enc = ?, ssh_public = ?, ssh_created_at = ?, updated_at = ? WHERE id = ?')
      .run(encrypt(k.privateKey), k.publicKey, Date.now(), Date.now(), botId)
    return botSsh.info(db, botId)
  },

  remove(db: Db, botId: string): void {
    db.prepare("UPDATE bots SET ssh_key_enc = '', ssh_public = '', ssh_created_at = NULL, updated_at = ? WHERE id = ?")
      .run(Date.now(), botId)
  },

  setHosts(db: Db, botId: string, hosts: unknown): SshHost[] {
    const clean = cleanHosts(hosts)
    db.prepare('UPDATE bots SET ssh_hosts_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(clean), Date.now(), botId)
    return clean
  },

  /** For the shim only: the private key, or '' (which unloads any key it holds). */
  privateKey(db: Db, botId: string): string {
    const r = row(db, botId)
    return r?.ssh_key_enc ? decrypt(r.ssh_key_enc) : ''
  },
}
