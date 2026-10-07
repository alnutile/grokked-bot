import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { promisify } from 'node:util'
import { COMPUTER_IMAGE, DOCKER_HOST_SOCK, IS_MAC } from '../config.ts'
import { log } from '../log.ts'

const execFileP = promisify(execFile)

// An app launched from Finder gets PATH=/usr/bin:/bin:/usr/sbin:/sbin, which has
// none of these. The docker CLI also shells out to credential helpers
// (docker-credential-desktop, -osxkeychain) by name, so their directories have
// to be on PATH too, not just the binary resolved.
const MAC_BIN_DIRS = [
  '/usr/local/bin',
  '/opt/homebrew/bin',
  '/Applications/Docker.app/Contents/Resources/bin',
  join(homedir(), '.orbstack', 'bin'),
  join(homedir(), '.docker', 'bin'),
  join(homedir(), '.rd', 'bin'),
]

const PATH = IS_MAC
  ? [...new Set([...(process.env.PATH ?? '').split(delimiter), ...MAC_BIN_DIRS])].filter(Boolean).join(delimiter)
  : process.env.PATH ?? ''

export const DOCKER_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  PATH,
  ...(DOCKER_HOST_SOCK ? { DOCKER_HOST: DOCKER_HOST_SOCK } : {}),
}

function findDocker(): string | null {
  for (const dir of PATH.split(delimiter)) {
    const p = join(dir, 'docker')
    if (dir && existsSync(p)) return p
  }
  return null
}

export const DOCKER_BIN = findDocker()

/** `docker ...` with the environment the daemon needs. Throws if docker is missing. */
export function docker(args: string[], opts: { timeout?: number } = {}) {
  if (!DOCKER_BIN) throw new Error('docker is not installed')
  return execFileP(DOCKER_BIN, args, { env: DOCKER_ENV, timeout: opts.timeout, maxBuffer: 16 * 1024 * 1024 })
}

// The bot's computer installs real Google Chrome, which only ships for x86-64
// Linux. On Apple Silicon this runs under Rosetta (Docker Desktop and OrbStack
// both enable it); on an amd64 host the flag is a no-op.
export const IMAGE_PLATFORM = 'linux/amd64'

/** Before the registry image existed the computer was built locally as
 *  grokked/computer:0.1. A dev setup keeps using that if it's there, so an
 *  existing Linux install doesn't suddenly try to pull 5GB. The packaged app
 *  always uses the published image, so it behaves the same on every machine. */
let resolvedImage: string | null = null
export async function computerImage(): Promise<string> {
  if (resolvedImage) return resolvedImage
  if (!process.env.GROKKED_IMAGE && !process.env.GROKKED_PACKAGED && await imagePresent('grokked/computer:0.1')) {
    resolvedImage = 'grokked/computer:0.1'
  } else {
    resolvedImage = COMPUTER_IMAGE
  }
  return resolvedImage
}

async function imagePresent(image: string): Promise<boolean> {
  try {
    await docker(['image', 'inspect', '--format', '{{.Id}}', image], { timeout: 15_000 })
    return true
  } catch {
    return false
  }
}

export type DockerState = 'missing' | 'not_running' | 'ok'
export type ImageState = 'missing' | 'pulling' | 'present' | 'failed'

export interface SystemStatus {
  platform: NodeJS.Platform
  docker: DockerState
  docker_detail: string | null
  image: string
  image_state: ImageState | null
  pull_progress: string | null
  pull_error: string | null
}

let pull: { state: 'pulling' | 'failed'; progress: string | null; error: string | null } | null = null

export async function systemStatus(): Promise<SystemStatus> {
  const image = await computerImage().catch(() => COMPUTER_IMAGE)
  const base = { platform: process.platform, image, pull_progress: pull?.progress ?? null, pull_error: pull?.error ?? null }
  if (!DOCKER_BIN) return { ...base, docker: 'missing', docker_detail: null, image_state: null }
  try {
    await docker(['info', '--format', '{{.ServerVersion}}'], { timeout: 10_000 })
  } catch (e) {
    const detail = String((e as { stderr?: string }).stderr ?? (e as Error).message).trim().split('\n').pop() ?? null
    return { ...base, docker: 'not_running', docker_detail: detail, image_state: null }
  }
  if (pull?.state === 'pulling') return { ...base, docker: 'ok', docker_detail: null, image_state: 'pulling' }
  if (await imagePresent(image)) {
    pull = null
    return { ...base, docker: 'ok', docker_detail: null, image_state: 'present' }
  }
  return { ...base, docker: 'ok', docker_detail: null, image_state: pull?.state === 'failed' ? 'failed' : 'missing' }
}

/** Starts a pull in the background; the UI polls systemStatus() for progress.
 *  The image is ~5GB, so this is the first-run wait, not something to block on. */
export async function startPull(): Promise<void> {
  if (pull?.state === 'pulling') return
  if (!DOCKER_BIN) throw new Error('docker is not installed')
  const image = await computerImage()
  pull = { state: 'pulling', progress: 'starting…', error: null }
  log.info({ image }, 'pulling bot computer image')

  const child = spawn(DOCKER_BIN, ['pull', '--platform', IMAGE_PLATFORM, image], { env: DOCKER_ENV })
  let tail = ''
  const onData = (b: Buffer) => {
    tail = (tail + b.toString()).slice(-4000)
    const last = tail.split(/[\r\n]+/).filter((l) => l.trim()).pop()
    if (last && pull) pull.progress = last.trim().slice(0, 200)
  }
  child.stdout.on('data', onData)
  child.stderr.on('data', onData)
  child.on('close', (code) => {
    if (code === 0) {
      log.info({ image }, 'image pulled')
      pull = null
    } else {
      const raw = tail.trim().split(/[\r\n]+/).filter((l) => l.trim()).pop() ?? `docker pull exited ${code}`
      // ghcr answers a bare "denied" both for a private image and one that
      // doesn't exist, which tells nobody anything.
      const error = /denied|not found|manifest unknown|unauthorized/i.test(raw)
        ? `Couldn't download ${image} (${raw.trim()}). It may not be published yet, or it's private and needs \`docker login ghcr.io\`.`
        : raw.trim()
      log.warn({ image, code, error }, 'image pull failed')
      pull = { state: 'failed', progress: null, error }
    }
  })
  child.on('error', (e) => { pull = { state: 'failed', progress: null, error: e.message } })
}
