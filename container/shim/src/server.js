import { createServer } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { Session, Fail } from './session.js'
import { readClipboard, writeClipboard } from './clipboard.js'

const PORT = Number(process.env.SHIM_PORT || 8088)
const TOKEN = process.env.SHIM_TOKEN || ''

const session = new Session()
let ready = false
let readyError = null

/**
 * Human takeover lease.
 *
 * The VNC session and the agent drive the same X server through the same XTEST
 * path, so without this they fight over the cursor: the human clicks, the agent
 * clicks somewhere else 200ms later, and neither can tell what happened. While a
 * lease is held the shim refuses to act, so control is unambiguous.
 */
let lease = null   // { holder, expires_at }

const leaseHeld = () => {
  if (lease && Date.now() >= lease.expires_at) lease = null
  return lease !== null
}

session.connect()
  .then(() => { ready = true; console.log('[shim] attached to Chrome over CDP') })
  .catch((e) => { readyError = e.message; console.error('[shim] attach failed:', e.message) })

const ACTIONS = new Set([
  'navigate', 'snapshot', 'click', 'type', 'select', 'find',
  'read_text', 'scroll', 'wait_for', 'screenshot', 'upload_file', 'desktop_action',
  'run_bash', 'read_file', 'write_file', 'edit_file', 'list_files', 'page_info', 'http_auth',
])

function authed(req) {
  if (!TOKEN) return true
  const h = req.headers.authorization || ''
  const got = h.startsWith('Bearer ') ? h.slice(7).trim() : ''
  const a = Buffer.from(got)
  const b = Buffer.from(TOKEN)
  return a.length === b.length && timingSafeEqual(a, b)
}

const json = (res, code, body) => {
  const payload = JSON.stringify(body)
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) })
  res.end(payload)
}

async function readBody(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  if (chunks.length === 0) return {}
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return null }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://shim')

  if (url.pathname === '/health') {
    return json(res, ready ? 200 : 503, { ok: ready, error: readyError, gen: session.gen })
  }
  if (!authed(req)) return json(res, 401, { ok: false, error: 'unauthorized' })

  if (req.method === 'POST' && url.pathname === '/session') {
    const body = await readBody(req)
    if (!body) return json(res, 400, { ok: false, error: 'bad_json' })
    if (Array.isArray(body.allowed_domains)) session.allowedDomains = body.allowed_domains
    return json(res, 200, { ok: true, allowed_domains: session.allowedDomains })
  }

  if (req.method === 'POST' && url.pathname === '/takeover') {
    const body = (await readBody(req)) ?? {}
    const ttl = Math.min(Number(body.ttl_s ?? 900), 3600)
    lease = { holder: body.holder ?? 'human', expires_at: Date.now() + ttl * 1000 }
    return json(res, 200, { ok: true, ...lease, ttl_s: ttl })
  }

  if (req.method === 'DELETE' && url.pathname === '/takeover') {
    lease = null
    return json(res, 200, { ok: true, released: true })
  }

  if (req.method === 'GET' && url.pathname === '/takeover') {
    return json(res, 200, { ok: true, held: leaseHeld(), lease })
  }

  if (req.method === 'GET' && url.pathname === '/clipboard') {
    return json(res, 200, { ok: true, text: await readClipboard() })
  }

  if (req.method === 'POST' && url.pathname === '/clipboard') {
    const body = await readBody(req)
    if (!body || typeof body.text !== 'string') return json(res, 400, { ok: false, error: 'bad_json' })
    try {
      await writeClipboard(body.text, { paste: body.paste === true })
      return json(res, 200, { ok: true })
    } catch (err) {
      return json(res, 500, { ok: false, error: 'clipboard_failed', message: String(err?.message ?? err) })
    }
  }

  if (req.method === 'POST' && url.pathname === '/act') {
    if (!ready) return json(res, 503, { ok: false, error: 'not_ready', message: readyError ?? 'attaching to Chrome' })
    if (leaseHeld()) {
      return json(res, 423, {
        ok: false,
        error: 'human_has_control',
        message: `${lease.holder} has taken over this computer until ${new Date(lease.expires_at).toISOString()}`,
        recovery: 'wait',
      })
    }
    const body = await readBody(req)
    if (!body) return json(res, 400, { ok: false, error: 'bad_json' })
    const { action, ...args } = body
    if (!ACTIONS.has(action)) {
      return json(res, 400, { ok: false, error: 'unknown_action', message: `unknown action: ${action}` })
    }
    try {
      const started = Date.now()
      const result = action === 'snapshot'
        ? await session.envelope(await session.snapshot(args))
        : await session[action](args)
      return json(res, 200, { ...result, took_ms: Date.now() - started })
    } catch (err) {
      // Structured, recoverable errors are worth more than any prompt tuning:
      // the model is told what went wrong and which tool fixes it.
      if (err instanceof Fail) {
        return json(res, 200, { ok: false, error: err.code, message: err.message, recovery: err.recovery })
      }
      return json(res, 200, { ok: false, error: 'action_failed', message: String(err?.message ?? err) })
    }
  }

  return json(res, 404, { ok: false, error: 'not_found' })
})

server.listen(PORT, '0.0.0.0', () => console.log(`[shim] listening on ${PORT}`))
process.on('SIGTERM', () => server.close(() => process.exit(0)))
