import { timingSafeEqual } from 'node:crypto'
import type { Server } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import { ClientFrame, PROTOCOL_VERSION, type Hello, type ServerFrame } from '@grokked/protocol'
import { INSTANCE_ID, VERSION } from '../config.ts'
import type { EventBus } from '../events.ts'
import { log } from '../log.ts'

interface Conn {
  ws: WebSocket
  topics: Set<string>
  since: number
  replayedTo: number
  alive: boolean
}

function safeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

export function attachWs(server: Server, bus: EventBus, token: string): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true })
  const conns = new Set<Conn>()

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname !== '/v1/stream') {
      socket.destroy()
      return
    }
    const provided = url.searchParams.get('token') ?? ''
    if (!safeEq(provided, token)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req, Number(url.searchParams.get('since') ?? 0))
    })
  })

  wss.on('connection', (ws: WebSocket, _req: import('node:http').IncomingMessage, since: number) => {
    const conn: Conn = { ws, topics: new Set(), since, replayedTo: since, alive: true }
    conns.add(conn)

    const hello: Hello = {
      daemon_version: VERSION,
      protocol: PROTOCOL_VERSION,
      instance_id: INSTANCE_ID,
      server_seq: bus.serverSeq(),
      dropped: bus.hasGap(since),
    }
    send(ws, { v: PROTOCOL_VERSION, seq: 0, ts: Date.now(), type: 'hello', topic: 'system', data: hello })

    ws.on('pong', () => { conn.alive = true })

    ws.on('message', (raw) => {
      let parsed: unknown
      try {
        parsed = JSON.parse(raw.toString())
      } catch {
        return sendError(ws, 'bad_json', 'frame was not valid JSON')
      }
      const result = ClientFrame.safeParse(parsed)
      if (!result.success) return sendError(ws, 'bad_frame', result.error.message)

      const frame = result.data
      if (frame.type === 'ping') {
        return send(ws, { v: PROTOCOL_VERSION, seq: 0, ts: Date.now(), type: 'pong', topic: 'system', data: {} })
      }
      if (frame.type === 'unsubscribe') {
        for (const t of frame.topics) conn.topics.delete(t)
        return
      }
      // subscribe: replay anything this client missed on the newly added topics
      const fresh = frame.topics.filter((t) => !conn.topics.has(t))
      for (const t of frame.topics) conn.topics.add(t)
      if (fresh.length > 0 && conn.since > 0) {
        for (const f of bus.replay(fresh, conn.since)) {
          if (f.seq > conn.replayedTo) send(ws, f)
        }
      }
    })

    ws.on('close', () => conns.delete(conn))
    ws.on('error', () => conns.delete(conn))
  })

  const unsubscribe = bus.subscribe((frame: ServerFrame) => {
    for (const conn of conns) {
      if (conn.topics.has(frame.topic)) {
        conn.replayedTo = Math.max(conn.replayedTo, frame.seq)
        send(conn.ws, frame)
      }
    }
  })

  const heartbeat = setInterval(() => {
    for (const conn of conns) {
      if (!conn.alive) {
        conn.ws.terminate()
        conns.delete(conn)
        continue
      }
      conn.alive = false
      try { conn.ws.ping() } catch { /* closing */ }
    }
  }, 30_000)
  heartbeat.unref()

  wss.on('close', () => {
    clearInterval(heartbeat)
    unsubscribe()
  })

  log.info('ws hub attached at /v1/stream')
  return wss
}

function send(ws: WebSocket, frame: ServerFrame): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame))
}

function sendError(ws: WebSocket, code: string, message: string): void {
  send(ws, {
    v: PROTOCOL_VERSION,
    seq: 0,
    ts: Date.now(),
    type: 'error',
    topic: 'system',
    data: { code, message },
  })
}
