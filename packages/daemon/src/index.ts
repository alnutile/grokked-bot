import { unlinkSync, writeFileSync, renameSync } from 'node:fs'
import { serve } from '@hono/node-server'
import {
  DB_PATH, DISCOVERY_PATH, HOST, INSTANCE_ID, PORT, VERSION,
  ensureDirs, loadOrCreateToken,
} from './config.ts'
import { openDb } from './db/index.ts'
import { EventBus } from './events.ts'
import { createApp } from './http/app.ts'
import { mountRuns, reclaimOrphanedRuns } from './http/runs.ts'
import { mountBots } from './http/bots.ts'
import { mountSettings } from './http/settings.ts'
import { backfillTitles } from './agent/titles.ts'
import { mountSystem } from './http/system.ts'
import { loadConfig } from './config.ts'
import { validateModels } from './model/openrouter.ts'
import { log } from './log.ts'
import { attachWs } from './ws/hub.ts'

const startedAt = Date.now()

ensureDirs()
const token = loadOrCreateToken()
const db = openDb()
const bus = new EventBus(db)
const app = createApp({ db, bus, token, startedAt })
mountBots(app, db)
mountSettings(app, db)
mountRuns(app, db, bus)
mountSystem(app)
reclaimOrphanedRuns(db, bus)
backfillTitles(db, bus)
void validateModels(Object.values(loadConfig().models))

const server = serve({ fetch: app.fetch, hostname: HOST, port: PORT }, (info) => {
  log.info({ host: HOST, port: info.port, instance: INSTANCE_ID, db: DB_PATH }, 'grokked daemon listening')
  writeDiscovery(info.port)
  notifySystemdReady()
})

const wss = attachWs(server as unknown as import('node:http').Server, bus, token)

// Retention sweep. Clients asking for a `since` older than this get
// hello{dropped:true} and do a full refetch instead of silently missing frames.
const prune = setInterval(() => {
  const n = bus.pruneOlderThanRetention()
  if (n > 0) log.debug({ pruned: n }, 'pruned expired events')
}, 60 * 60 * 1000)
prune.unref()

/** $XDG_RUNTIME_DIR is tmpfs, so a hard crash leaves this file behind.
 *  Clients must always health-check rather than trust its existence. */
function writeDiscovery(port: number): void {
  const tmp = `${DISCOVERY_PATH}.tmp`
  const body = JSON.stringify(
    { pid: process.pid, port, version: VERSION, instance_id: INSTANCE_ID, started_at: startedAt, db_path: DB_PATH },
    null, 2,
  )
  writeFileSync(tmp, body + '\n', { mode: 0o600 })
  renameSync(tmp, DISCOVERY_PATH)
}

/** No-op unless the unit is Type=notify. */
function notifySystemdReady(): void {
  const sock = process.env.NOTIFY_SOCKET
  if (!sock) return
  import('node:dgram').then(({ createSocket }) => {
    const c = createSocket('unix_dgram' as never)
    const path = sock.startsWith('@') ? '\0' + sock.slice(1) : sock
    c.send(Buffer.from('READY=1'), path as never, () => c.close())
  }).catch(() => { /* not fatal */ })
}

let shuttingDown = false
function shutdown(signal: string): void {
  if (shuttingDown) return
  shuttingDown = true
  log.info({ signal }, 'shutting down')
  clearInterval(prune)
  wss.close()
  server.close(() => {
    try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)') } catch { /* best effort */ }
    try { db.close() } catch { /* best effort */ }
    try { unlinkSync(DISCOVERY_PATH) } catch { /* already gone */ }
    log.info('bye')
    process.exit(0)
  })
  setTimeout(() => process.exit(1), 20_000).unref()
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
