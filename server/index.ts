import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, resolve } from 'node:path'
import { timingSafeEqual } from 'node:crypto'
import { getSessionInfo, getSessionMessages, listSessions } from '@anthropic-ai/claude-agent-sdk'
import { WebSocketServer, type WebSocket } from 'ws'
import type { ClientEvent, ServerEvent, SessionSummary, WireMessage } from '../shared/protocol.ts'
import { SessionManager } from './session.ts'

loadDotEnv()

const PORT = Number(process.env.PORT ?? 3001)
const HOST = process.env.HOST ?? '127.0.0.1'
const WORKSPACE_DIR = resolve(process.env.WORKSPACE_DIR ?? process.cwd())
const AUTH_TOKEN = process.env.AUTH_TOKEN || ''
const DIST = resolve('dist')

// ── Fan-out: which sockets are viewing which session ──

const viewers = new Map<string, Set<WebSocket>>()
const sockets = new Set<WebSocket>()

function send(ws: WebSocket, event: ServerEvent): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(event))
}

function broadcast(event: ServerEvent): void {
  const targets = 'sessionId' in event && event.sessionId ? viewers.get(event.sessionId) : sockets
  for (const ws of targets ?? []) send(ws, event)
}

const manager = new SessionManager(() => broadcast({ type: 'sessions_changed' }))

async function snapshotFor(sessionId: string): Promise<ServerEvent> {
  const live = manager.get(sessionId)
  if (live) return live.snapshot()
  const [info, messages] = await Promise.all([getSessionInfo(sessionId), getSessionMessages(sessionId)])
  return {
    type: 'snapshot',
    sessionId,
    messages: messages as unknown as WireMessage[],
    running: false,
    mode: 'auto',
    cwd: info?.cwd,
    permissions: [],
    bashOutput: {},
  }
}

async function handleClient(ws: WebSocket, event: ClientEvent): Promise<void> {
  switch (event.type) {
    case 'subscribe': {
      let set = viewers.get(event.sessionId)
      if (!set) viewers.set(event.sessionId, (set = new Set()))
      set.add(ws)
      send(ws, await snapshotFor(event.sessionId))
      return
    }
    case 'unsubscribe':
      viewers.get(event.sessionId)?.delete(ws)
      return
    case 'send': {
      const isNew = !manager.get(event.sessionId)
      const session = await manager.open(event.sessionId, { cwd: event.cwd, mode: event.mode })
      if (isNew) session.subscribe(broadcast)
      if (!session.send(event.text)) throw new Error('Session is closed; try again')
      return
    }
    case 'interrupt':
      await manager.get(event.sessionId)?.interrupt()
      return
    case 'set_mode':
      await manager.get(event.sessionId)?.setMode(event.mode)
      return
    case 'permission':
      manager.get(event.sessionId)?.resolvePermission(event.requestId, event.decision, event.message, event.updatedInput)
      return
  }
}

// ── HTTP ──

async function sessionList(): Promise<SessionSummary[]> {
  const infos = await listSessions({ limit: 200 })
  const summaries: SessionSummary[] = infos.map((s) => ({
    id: s.sessionId,
    title: s.customTitle || s.summary || s.firstPrompt || 'Untitled',
    cwd: s.cwd,
    lastModified: s.lastModified,
    running: manager.isRunning(s.sessionId),
  }))
  // A brand-new live session may not have a transcript on disk yet.
  for (const id of manager.liveIds()) {
    if (!summaries.some((s) => s.id === id)) {
      summaries.unshift({ id, title: 'New chat', cwd: manager.get(id)?.cwd, lastModified: Date.now(), running: manager.isRunning(id) })
    }
  }
  return summaries
}

function authorized(header: string | undefined, queryToken: string | null): boolean {
  if (!AUTH_TOKEN) return true
  const supplied = header?.replace(/^Bearer /, '') || queryToken || ''
  const a = Buffer.from(supplied)
  const b = Buffer.from(AUTH_TOKEN)
  return a.length === b.length && timingSafeEqual(a, b)
}

const MIME: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x')
  const json = (status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  try {
    if (url.pathname === '/api/config') return json(200, { defaultCwd: WORKSPACE_DIR, authRequired: !!AUTH_TOKEN })
    if (url.pathname.startsWith('/api/')) {
      if (!authorized(req.headers.authorization, null)) return json(401, { error: 'Unauthorized' })
      if (url.pathname === '/api/sessions') return json(200, await sessionList())
      return json(404, { error: 'Not found' })
    }
    // Production: serve the built client, falling back to index.html for client routes.
    let file = join(DIST, url.pathname)
    if (!file.startsWith(DIST) || !existsSync(file) || statSync(file).isDirectory()) file = join(DIST, 'index.html')
    if (!existsSync(file)) return json(404, { error: 'Client not built; run `pnpm build` or use `pnpm dev`' })
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' })
    createReadStream(file).pipe(res)
  } catch (err) {
    json(500, { error: err instanceof Error ? err.message : String(err) })
  }
})

const wss = new WebSocketServer({ noServer: true })

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', 'http://x')
  if (url.pathname !== '/ws' || !authorized(undefined, url.searchParams.get('token'))) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
    socket.destroy()
    return
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws))
})

wss.on('connection', (ws: WebSocket) => {
  sockets.add(ws)
  // Handle each socket's events in order so a snapshot can't overtake a later status.
  let chain = Promise.resolve()
  ws.on('message', (raw) => {
    let event: ClientEvent
    try {
      event = JSON.parse(String(raw))
    } catch {
      return
    }
    chain = chain.then(() =>
      handleClient(ws, event).catch((err) =>
        send(ws, {
          type: 'error',
          sessionId: 'sessionId' in event ? event.sessionId : undefined,
          error: err instanceof Error ? err.message : String(err),
        }),
      ),
    )
  })
  ws.on('close', () => {
    sockets.delete(ws)
    for (const set of viewers.values()) set.delete(ws)
  })
})

server.listen(PORT, HOST, () => {
  console.log(`badger server on http://${HOST}:${PORT} (workspace ${WORKSPACE_DIR}${AUTH_TOKEN ? ', auth on' : ''})`)
})

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    manager.closeAll()
    process.exit(0)
  })
}

function loadDotEnv(): void {
  if (!existsSync('.env')) return
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m && m[2] && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
}
