import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { CONTAINER_PREFIX, DATA_DIR } from '../config.ts'
import { log } from '../log.ts'
import { IMAGE_PLATFORM, computerImage, docker } from './docker.ts'

export interface ActResult { ok: boolean; [k: string]: unknown }

/**
 * The bot's computer. Deliberately a narrow interface: the agent loop never
 * touches Docker or CDP directly, which is what makes "move the daemon to a
 * remote box" a swap of this class rather than a rewrite.
 */
export interface BotRuntime {
  ensureUp(): Promise<void>
  act(action: string, args: Record<string, unknown>): Promise<ActResult>
  setAllowedDomains(domains: string[]): Promise<void>
  isHumanInControl(): Promise<boolean>
  vncUrl(): Promise<string>
}

export class LocalDockerRuntime implements BotRuntime {
  // Node's strip-only TS mode rejects parameter properties, so fields are explicit.
  readonly name: string
  readonly image: string | undefined

  constructor(name: string, image?: string) {
    this.name = CONTAINER_PREFIX + name
    this.image = image
  }

  async ensureUp(): Promise<void> {
    let running = await this.#state()

    // Recreate a computer that is out of date: built from an older image, or from
    // before per-bot ports (all pinned to 16080/18088, so only one bot could be
    // up). The profile volume and work dir carry over, so logins survive.
    const stale = running !== null && await this.#staleReason()
    if (stale) {
      log.info({ bot: this.name, reason: stale }, 'recreating bot computer')
      await docker(['rm', '-f', this.name])
      running = null
    }

    if (running === 'running') { await this.#waitHealthy(); return }

    if (running === null) {
      log.info({ bot: this.name }, 'creating bot computer')
      const work = join(DATA_DIR, 'bots', this.name, 'work')
      // Create it ourselves: if Docker does, it may end up owned by root.
      mkdirSync(work, { recursive: true, mode: 0o700 })
      await docker([
        'run', '-d', '--name', this.name, '--platform', IMAGE_PLATFORM,
        '-v', `${this.name}-profile:/data/profile`,
        '-v', `${work}:/data/work`,
        '--shm-size=2g', '--memory=6g', '--cpus=3', '--pids-limit=1024',
        '--security-opt', 'no-new-privileges',
        '-p', '127.0.0.1::6080',
        '-p', '127.0.0.1::8088',
        this.image ?? await computerImage(),
      ])
    } else {
      log.info({ bot: this.name, state: running }, 'starting existing bot computer')
      await docker(['start', this.name])
    }
    await this.#waitHealthy()
  }

  async #state(): Promise<string | null> {
    try {
      const { stdout } = await docker(['inspect', '-f', '{{.State.Status}}', this.name])
      return stdout.trim()
    } catch {
      return null
    }
  }

  async #staleReason(): Promise<string | null> {
    const { stdout } = await docker(['inspect', '-f', '{{.Image}} {{json .HostConfig.PortBindings}}', this.name])
    const [imageId, json] = [stdout.slice(0, stdout.indexOf(' ')), stdout.slice(stdout.indexOf(' ') + 1)]
    const bindings = JSON.parse(json) as Record<string, Array<{ HostPort: string }>> | null
    if (Object.values(bindings ?? {}).some((bs) => bs.some((b) => b.HostPort !== ''))) return 'pinned ports'
    const current = await docker(['image', 'inspect', '-f', '{{.Id}}', this.image ?? await computerImage()])
      .then((r) => r.stdout.trim()).catch(() => null)
    if (current && current !== imageId) return 'newer image'
    return null
  }

  /** Host ports Docker actually bound. Docker picks free ones per container and
   *  may pick new ones on every start, so they're looked up rather than cached. */
  async ports(): Promise<{ shim: number; vnc: number }> {
    const port = async (p: number) => {
      const { stdout } = await docker(['port', this.name, `${p}/tcp`])
      return Number(stdout.trim().split('\n')[0]!.split(':').pop())
    }
    const [vnc, shim] = await Promise.all([port(6080), port(8088)])
    return { shim, vnc }
  }

  async shimUrl(path: string): Promise<string> {
    return `http://127.0.0.1:${(await this.ports()).shim}${path}`
  }

  async #waitHealthy(timeoutMs = 120_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    let last = ''
    while (Date.now() < deadline) {
      try {
        const r = await fetch(await this.shimUrl('/health'), {
          signal: AbortSignal.timeout(2000),
        })
        const body = (await r.json()) as { ok: boolean; error?: string }
        if (body.ok) return
        last = body.error ?? 'not ready'
      } catch (e) {
        last = (e as Error).message
      }
      await new Promise((r) => setTimeout(r, 1000))
    }
    throw new Error(`bot computer ${this.name} never became healthy: ${last}`)
  }

  async act(action: string, args: Record<string, unknown>): Promise<ActResult> {
    const res = await fetch(await this.shimUrl('/act'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action, ...args }),
      signal: AbortSignal.timeout(180_000),
    })
    const body = (await res.json()) as ActResult
    // 423 is the human takeover lease, not a failure: the loop sleeps on it.
    if (res.status === 423) return { ...body, ok: false, error: 'human_has_control', recovery: 'wait' }
    return body
  }

  async setAllowedDomains(domains: string[]): Promise<void> {
    await fetch(await this.shimUrl('/session'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ allowed_domains: domains }),
    })
  }

  async isHumanInControl(): Promise<boolean> {
    try {
      const r = await fetch(await this.shimUrl('/takeover'), {
        signal: AbortSignal.timeout(2000),
      })
      return ((await r.json()) as { held: boolean }).held
    } catch {
      return false
    }
  }

  /** Generated inside the container on first boot. Loopback-only, but the UI
   *  still needs it to connect without prompting the human every time. */
  async vncPassword(): Promise<string | null> {
    try {
      const { stdout } = await docker(['exec', this.name, 'cat', '/data/profile/.vncpasswd.txt'])
      return stdout.trim() || null
    } catch {
      return null
    }
  }

  async vncUrl(): Promise<string> {
    return `http://127.0.0.1:${(await this.ports()).vnc}/vnc.html?autoconnect=1&resize=scale`
  }
}
