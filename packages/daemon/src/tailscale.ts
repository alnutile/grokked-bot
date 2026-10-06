import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'
import { HOOKS_PORT } from './config.ts'

const exec = promisify(execFile)

/**
 * Tailscale is the default way to reach webhooks from other machines: `serve`
 * puts the hooks listener on your tailnet with HTTPS, and `funnel` puts public
 * hooks on the internet. Only the hooks listener is ever exposed.
 *
 *   tailnet:  https://<machine>.<tailnet>.ts.net/hooks/<id>       -> :8788/hooks
 *   public:   https://<machine>.<tailnet>.ts.net:8443/hooks/<id>  -> :8788/public/hooks
 *
 * Not using Tailscale? Point Headscale, WireGuard, Caddy or a Cloudflare Tunnel
 * at the hooks port instead; nothing here is required.
 */

const FUNNEL_PORT = 8443
const target = (path: string) => `http://127.0.0.1:${HOOKS_PORT}${path}`

function binary(): string | null {
  for (const dir of [...(process.env.PATH ?? '').split(':'), '/snap/bin', '/usr/bin', '/usr/local/bin']) {
    if (dir && existsSync(`${dir}/tailscale`)) return `${dir}/tailscale`
  }
  return null
}

async function ts(args: string[]): Promise<string> {
  const bin = binary()
  if (!bin) throw new Error('Tailscale is not installed')
  try {
    const { stdout } = await exec(bin, args, { timeout: 20_000 })
    return stdout
  } catch (e: any) {
    const msg = String(e.stderr || e.message || e)
    if (/access denied|permission denied|operator/i.test(msg)) {
      throw new Error('Tailscale needs permission to change its settings. Run once: sudo tailscale set --operator=$USER')
    }
    if (/funnel.*not.*(enabled|allowed)|requires.*funnel/i.test(msg)) {
      throw new Error('Funnel is not enabled for this tailnet. Enable it in the Tailscale admin console (Access controls → funnel), then try again.')
    }
    throw new Error(msg.trim().split('\n').slice(0, 3).join(' '))
  }
}

export interface RemoteStatus {
  installed: boolean
  logged_in: boolean
  login_url?: string
  dns_name?: string
  serving: boolean
  funnel: boolean
  hooks_port: number
  tailnet_base?: string
  public_base?: string
  local_base: string
}

export async function status(): Promise<RemoteStatus> {
  const local_base = `http://127.0.0.1:${HOOKS_PORT}`
  const base: RemoteStatus = { installed: !!binary(), logged_in: false, serving: false, funnel: false, hooks_port: HOOKS_PORT, local_base }
  if (!base.installed) return base
  const st = JSON.parse(await ts(['status', '--json']).catch(() => '{}')) as any
  base.logged_in = st.BackendState === 'Running'
  if (st.AuthURL) base.login_url = st.AuthURL
  const dns = String(st.Self?.DNSName ?? '').replace(/\.$/, '')
  if (dns) base.dns_name = dns
  if (!base.logged_in) return base
  const serve = await ts(['serve', 'status', '--json']).catch(() => '{}')
  base.serving = serve.includes(target('/hooks'))
  base.funnel = serve.includes(target('/public/hooks')) && /"AllowFunnel"\s*:\s*\{[^}]*:8443"\s*:\s*true/.test(serve)
  if (dns) {
    base.tailnet_base = `https://${dns}`
    base.public_base = `https://${dns}:${FUNNEL_PORT}`
  }
  return base
}

/** Put the hooks listener on the tailnet (HTTPS on 443, path /hooks only). */
export async function setServe(on: boolean): Promise<void> {
  await ts(on
    ? ['serve', '--bg', '--yes', '--https=443', '--set-path', '/hooks', target('/hooks')]
    : ['serve', '--https=443', '--set-path', '/hooks', 'off'])
}

/** Put public hooks on the internet via Funnel (HTTPS on 8443). */
export async function setFunnel(on: boolean): Promise<void> {
  await ts(on
    ? ['funnel', '--bg', '--yes', `--https=${FUNNEL_PORT}`, '--set-path', '/hooks', target('/public/hooks')]
    : ['funnel', `--https=${FUNNEL_PORT}`, '--set-path', '/hooks', 'off'])
}
