import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { DOCKER_HOST_SOCK } from '../config.ts'
import { log } from '../log.ts'

const exec = promisify(execFile)
const env = { ...process.env, DOCKER_HOST: DOCKER_HOST_SOCK }

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
  vncUrl(): string
}

export class LocalDockerRuntime implements BotRuntime {
  // Node's strip-only TS mode rejects parameter properties, so fields are explicit.
  readonly name: string
  readonly shimPort: number
  readonly vncPort: number
  readonly image: string

  constructor(name: string, shimPort = 18088, vncPort = 16080, image = 'grokked/computer:0.1') {
    this.name = name
    this.shimPort = shimPort
    this.vncPort = vncPort
    this.image = image
  }

  async ensureUp(): Promise<void> {
    const running = await this.#state()
    if (running === 'running') { await this.#waitHealthy(); return }

    if (running === null) {
      log.info({ bot: this.name }, 'creating bot computer')
      await exec('docker', [
        'run', '-d', '--name', this.name,
        '-v', `${this.name}-profile:/data/profile`,
        '-v', `${process.env.HOME}/.local/share/grokked/bots/${this.name}/work:/data/work`,
        '--shm-size=2g', '--memory=6g', '--cpus=3', '--pids-limit=1024',
        '--security-opt', 'no-new-privileges',
        '-p', `127.0.0.1:${this.vncPort}:6080`,
        '-p', `127.0.0.1:${this.shimPort}:8088`,
        this.image,
      ], { env })
    } else {
      log.info({ bot: this.name, state: running }, 'starting existing bot computer')
      await exec('docker', ['start', this.name], { env })
    }
    await this.#waitHealthy()
  }

  async #state(): Promise<string | null> {
    try {
      const { stdout } = await exec('docker', ['inspect', '-f', '{{.State.Status}}', this.name], { env })
      return stdout.trim()
    } catch {
      return null
    }
  }

  async #waitHealthy(timeoutMs = 120_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    let last = ''
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`http://127.0.0.1:${this.shimPort}/health`, {
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
    const res = await fetch(`http://127.0.0.1:${this.shimPort}/act`, {
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
    await fetch(`http://127.0.0.1:${this.shimPort}/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ allowed_domains: domains }),
    })
  }

  async isHumanInControl(): Promise<boolean> {
    try {
      const r = await fetch(`http://127.0.0.1:${this.shimPort}/takeover`, {
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
      const { stdout } = await exec('docker', ['exec', this.name, 'cat', '/data/profile/.vncpasswd.txt'], { env })
      return stdout.trim() || null
    } catch {
      return null
    }
  }

  vncUrl(): string {
    return `http://127.0.0.1:${this.vncPort}/vnc.html?autoconnect=1&resize=scale`
  }
}
