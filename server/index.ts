import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage } from 'node:http'
import { homedir } from 'node:os'
import { extname, isAbsolute, join, resolve } from 'node:path'
import { getSessionInfo, listSessions, renameSession } from '@anthropic-ai/claude-agent-sdk'
import { WebSocketServer, type WebSocket } from 'ws'
import { IMAGE_TYPES, type AnswerDraft, type ClientEvent, type DraftAttachments, type ServerEvent, type SessionSummary } from '../shared/protocol.ts'
import { BOARD_AUTO_ALLOWED, BOARD_SERVER, boardServer, cardContext } from './boardTools.ts'
import { Children } from './children.ts'
import { type Actor, BadRequest, type Draft, Store } from './db.ts'
import { MERGE_TOOL, mergeTool } from './merge.ts'
import { SessionManager, diskTranscript, listModels, transcriptModel } from './session.ts'
import { TERMINAL_AUTO_ALLOWED, TERMINAL_SERVER, terminalServer } from './terminalTools.ts'
import { Terminals, shellEnv } from './terminals.ts'
import { suggestTitle } from './titles.ts'
import { excludeWorktrees, inaccessible, removeWorktree, workspaceRoot, worktreeStatus } from './workspace.ts'

// Terminals get the environment Badger was started with, before .env adds PORT and friends.
const startEnv = shellEnv(process.env)
loadDotEnv()

const PORT = Number(process.env.PORT ?? 3001)
const HOST = process.env.HOST ?? '127.0.0.1'
const WORKSPACE_DIR = resolve(process.env.WORKSPACE_DIR ?? process.cwd())
const DIST = resolve('dist')
const DATA_DIR = resolve(process.env.DATA_DIR ?? 'data')
// Folderless chats run here. Outside DATA_DIR, which defaults to inside this repo.
const SCRATCH_DIR = resolve(process.env.SCRATCH_DIR || join(homedir(), '.badger', 'scratch'))

mkdirSync(SCRATCH_DIR, { recursive: true })
if (!existsSync(join(SCRATCH_DIR, 'CLAUDE.md'))) {
  writeFileSync(
    join(SCRATCH_DIR, 'CLAUDE.md'),
    'Chats here are general questions, not tied to any project. There is no codebase to explore; just answer. This folder is shared scratch space for every such chat.\n',
  )
}

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

const store = new Store(DATA_DIR, () => broadcast({ type: 'sessions_changed' }))
/** Changes made through the REST API and WebSocket, i.e. by someone in the browser. */
const UI: Actor = { source: 'ui' }
const terminals = new Terminals(DATA_DIR, startEnv)
const cardsChanged = () => broadcast({ type: 'cards_changed' })
// Merging only starts a chat in the main checkout, and that chat asks for anything risky itself.
const MERGE_TOOL_NAME = `mcp__${BOARD_SERVER}__${MERGE_TOOL}`
const manager: SessionManager = new SessionManager(
  () => broadcast({ type: 'sessions_changed' }),
  (sessionId, cwd) => ({
    mcpServers: {
      [BOARD_SERVER]: boardServer(store, sessionId, cardsChanged, [
        mergeTool(
          {
            store,
            manager,
            terminals,
            children,
            onChange: () => {
              cardsChanged()
              broadcast({ type: 'sessions_changed' })
            },
          },
          sessionId,
          cwd,
          MERGE_TOOL_NAME,
        ),
      ]),
      [TERMINAL_SERVER]: terminalServer(terminals, sessionId, cwd),
    },
    allowedTools: [...BOARD_AUTO_ALLOWED, MERGE_TOOL_NAME, ...TERMINAL_AUTO_ALLOWED],
    turnContext: () => cardContext(store, sessionId),
  }),
)
const children = new Children(manager, store, broadcast)

// ── Terminals: which sockets are watching which terminal ──

/**
 * Per terminal, the sockets viewing it and how many views each has open. A
 * socket isn't live until its snapshot goes out: output before then is
 * already in the snapshot.
 */
const termViewers = new Map<string, Map<WebSocket, { views: number; live: boolean }>>()

terminals.on((e) => {
  if (e.type === 'terminals') {
    broadcast({ type: 'terminals', terminals: e.terminals })
    for (const id of termViewers.keys()) if (!e.terminals.some((t) => t.id === id)) termViewers.delete(id)
    return
  }
  for (const [ws, v] of termViewers.get(e.id) ?? []) if (v.live) send(ws, { type: 'term_output', id: e.id, data: e.data })
})

/** Every subscribe gets a fresh snapshot, which also resets any view of it the socket already has. */
function subscribeTerminal(ws: WebSocket, id: string): void {
  let viewers = termViewers.get(id)
  if (!viewers) termViewers.set(id, (viewers = new Map()))
  const v = viewers.get(ws) ?? { views: 0, live: false }
  viewers.set(ws, { views: v.views + 1, live: false })
  terminals.snapshot(id, (data) => {
    const current = termViewers.get(id)?.get(ws)
    if (!current || current.live) return
    current.live = true
    send(ws, { type: 'term_snapshot', id, data: data ?? '' })
  })
}

function unsubscribeTerminal(ws: WebSocket, id: string): void {
  const v = termViewers.get(id)?.get(ws)
  if (v && --v.views <= 0) termViewers.get(id)!.delete(ws)
}

async function snapshotFor(sessionId: string): Promise<ServerEvent> {
  const { text: draft, attachments: draftAttachments } = store.draft(sessionId)
  const childSessions = store.children(sessionId)
  const live = manager.get(sessionId)
  if (live) return { ...(await live.snapshot()), draft, draftAttachments, children: childSessions }
  const [info, messages] = await Promise.all([getSessionInfo(sessionId), diskTranscript(sessionId)])
  return {
    type: 'snapshot',
    sessionId,
    messages,
    running: false,
    mode: 'auto',
    model: transcriptModel(messages),
    cwd: info?.cwd,
    gone: !!info?.cwd && inaccessible(info.cwd),
    permissions: [],
    bashOutput: {},
    draft,
    draftAttachments,
    children: childSessions,
    background: [],
  }
}

/** Stores parts of a chat's draft and shows them to the chat's other viewers; the one editing it already has them. */
function saveDraft(from: WebSocket, sessionId: string, change: Partial<Draft>): void {
  const saved = store.draft(sessionId)
  const same = (change.text === undefined || change.text === saved.text) && (!change.attachments || !hasAttachments(change.attachments) && !hasAttachments(saved.attachments))
  if (same) return
  store.setDraft(sessionId, change)
  for (const ws of viewers.get(sessionId) ?? []) if (ws !== from) send(ws, { type: 'draft', sessionId, ...change })
}

const hasAttachments = (a: DraftAttachments) => a.pastes.length > 0 || a.images.length > 0

/** Checks attachments from a client, throwing on anything malformed. */
function checkAttachments(a: Partial<DraftAttachments>): DraftAttachments {
  const { pastes = [], images = [] } = a
  if (!Array.isArray(pastes) || pastes.some((p) => typeof p !== 'string')) throw new BadRequest('pastes must be strings')
  if (!Array.isArray(images) || images.some((i) => !IMAGE_TYPES.includes(i?.mediaType) || typeof i.data !== 'string')) {
    throw new BadRequest(`images must be ${IMAGE_TYPES.join(', ')}`)
  }
  return { pastes, images }
}

/** Checks question answers from a client, throwing on anything malformed. */
function checkAnswers(a: Partial<AnswerDraft> | undefined): AnswerDraft {
  const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
  const { picked = {}, other = {} } = a ?? {}
  if (!isRecord(picked) || Object.values(picked).some((l) => !Array.isArray(l) || l.some((s) => typeof s !== 'string'))) {
    throw new BadRequest('picked must map questions to lists of labels')
  }
  if (!isRecord(other) || Object.values(other).some((s) => typeof s !== 'string')) throw new BadRequest('other must map questions to text')
  return { picked, other } as AnswerDraft
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
      const { pastes, images } = checkAttachments(event)
      // Picking an archived chat back up brings it back to the sidebar.
      store.setArchived(event.sessionId, false, UI)
      // Sending empties the composer in every tab, not just the one that sent.
      saveDraft(ws, event.sessionId, { text: '', attachments: { pastes: [], images: [] } })
      const isNew = !manager.get(event.sessionId)
      if (isNew && event.worktree !== undefined && event.cwd) {
        await excludeWorktrees(event.cwd).catch(() => {
          throw new Error(`${event.cwd} isn't a git repository, so it can't have worktrees`)
        })
      }
      if (event.model !== undefined && typeof event.model !== 'string') throw new BadRequest('model must be a string')
      const session = await manager.open(event.sessionId, { cwd: event.cwd, mode: event.mode, model: event.model, worktree: event.worktree })
      if (isNew) session.subscribe(broadcast)
      if (!session.send(event.text, pastes, images)) throw new Error('Session is closed; try again')
      return
    }
    case 'draft':
      if (event.text !== undefined && typeof event.text !== 'string') throw new BadRequest('text must be a string')
      saveDraft(ws, event.sessionId, { text: event.text, attachments: event.attachments && checkAttachments(event.attachments) })
      return
    case 'interrupt':
      await Promise.all([manager.get(event.sessionId)?.interrupt(), children.interrupt(event.sessionId)])
      return
    case 'stop_task':
      await manager.get(event.sessionId)?.stopTask(event.taskId)
      return
    case 'set_mode':
      await manager.get(event.sessionId)?.setMode(event.mode)
      return
    case 'set_model':
      if (typeof event.model !== 'string') throw new BadRequest('model must be a string')
      // A chat that isn't running takes the model with its next message.
      await manager.get(event.sessionId)?.setModel(event.model)
      return
    case 'permission':
      manager.get(event.sessionId)?.resolvePermission(event.requestId, event.decision, event.message, event.updatedInput)
      return
    case 'answer_draft': {
      const answers = checkAnswers(event.answers)
      // Shown to the chat's other viewers; the one answering already has it.
      if (!manager.get(event.sessionId)?.draftAnswers(event.requestId, answers)) return
      const update: ServerEvent = { type: 'answer_draft', sessionId: event.sessionId, requestId: event.requestId, answers }
      for (const other of viewers.get(event.sessionId) ?? []) if (other !== ws) send(other, update)
      return
    }
    case 'term_subscribe':
      subscribeTerminal(ws, event.id)
      return
    case 'term_unsubscribe':
      unsubscribeTerminal(ws, event.id)
      return
    case 'term_input':
      terminals.input(event.id, event.data)
      return
    case 'term_resize':
      terminals.resize(event.id, event.cols, event.rows)
      return
  }
}

// ── HTTP ──

async function sessionList(): Promise<SessionSummary[]> {
  const infos = await listSessions({ limit: 200 })
  const archived = store.archivedIds()
  // Children show inside the chat that started them.
  const childIds = store.childIds()
  const exists = new Map<string, boolean>()
  const gone = (cwd?: string) => {
    if (!cwd) return false
    if (!exists.has(cwd)) exists.set(cwd, !inaccessible(cwd))
    return !exists.get(cwd)
  }
  const summaries: SessionSummary[] = infos.filter((s) => !childIds.has(s.sessionId)).map((s) => ({
    id: s.sessionId,
    title: s.customTitle || s.summary || s.firstPrompt || 'Untitled',
    // A live chat may have moved into a worktree since its transcript was last written.
    cwd: manager.get(s.sessionId)?.cwd ?? s.cwd,
    lastModified: s.lastModified,
    running: manager.isRunning(s.sessionId),
    archived: archived.has(s.sessionId),
    gone: gone(s.cwd),
  }))
  // A brand-new live session may not have a transcript on disk yet.
  for (const id of manager.liveIds()) {
    if (!childIds.has(id) && !summaries.some((s) => s.id === id)) {
      summaries.unshift({ id, title: 'New chat', cwd: manager.get(id)?.cwd, lastModified: Date.now(), running: manager.isRunning(id), archived: false })
    }
  }
  return summaries
}

/** Card routes. Returns undefined when the path isn't one of them. */
async function cardsApi(method: string, path: string, req: IncomingMessage): Promise<[number, unknown] | undefined> {
  if (path === '/api/cards') {
    if (method === 'GET') return [200, store.cards()]
    if (method === 'POST') return changed([201, store.createCard(await readJson(req), UI)])
  }
  const card = path.match(/^\/api\/cards\/(\d+)$/)
  if (card) {
    const id = Number(card[1])
    if (method === 'GET') return found(store.card(id))
    if (method === 'PATCH') return changed(found(store.updateCard(id, await readJson(req), UI)))
    if (method === 'DELETE') return changed(store.deleteCard(id, UI) ? [204, null] : [404, { error: 'No such card' }])
  }
  const link = path.match(/^\/api\/cards\/(\d+)\/sessions(?:\/([0-9a-f-]{36}))?$/)
  if (link) {
    const id = Number(link[1])
    if (!store.card(id)) return [404, { error: 'No such card' }]
    if (method === 'POST' && !link[2]) {
      const { sessionId } = await readJson(req)
      if (typeof sessionId !== 'string' || !/^[0-9a-f-]{36}$/.test(sessionId)) throw new BadRequest('sessionId is required')
      store.linkSession(id, sessionId, UI)
      return changed([200, store.card(id)])
    }
    if (method === 'DELETE' && link[2]) {
      store.unlinkSession(id, link[2], UI)
      return changed([200, store.card(id)])
    }
  }
  return undefined
}

/** Archive and title routes. Archiving only hides a chat; its transcript is left alone. */
async function sessionsApi(method: string, path: string, req: IncomingMessage): Promise<[number, unknown] | undefined> {
  const m = path.match(/^\/api\/sessions\/([0-9a-f-]{36})\/(archive|title|title\/suggest)$/)
  if (!m) return undefined
  const [, id, action] = m
  if (action === 'archive') {
    if (method === 'POST') return (store.setArchived(id, true, UI), [204, null])
    if (method === 'DELETE') return (store.setArchived(id, false, UI), [204, null])
  }
  // The title goes in the transcript, where the CLI's /resume sees it too.
  if (action === 'title' && method === 'PUT') {
    const { title } = await readJson(req)
    if (typeof title !== 'string' || !title.trim()) throw new BadRequest('title is required')
    await renameSession(id, title.trim()).catch(badRequest)
    broadcast({ type: 'sessions_changed' })
    return [204, null]
  }
  if (action === 'title/suggest' && method === 'POST') {
    const info = await getSessionInfo(id)
    if (!info) return [404, { error: 'No such chat' }]
    const current = info.customTitle || info.summary || info.firstPrompt || ''
    const card = store.cards().find((c) => c.sessionIds.includes(id))
    return [200, { title: await suggestTitle(id, current, card, SCRATCH_DIR).catch(badRequest) }]
  }
  return undefined
}

/** Worktree routes, by path. Making them is Claude Code's job (--worktree); these look and clean up. */
async function worktreesApi(method: string, path: string, url: URL): Promise<[number, unknown] | undefined> {
  if (path !== '/api/worktree') return undefined
  const dir = url.searchParams.get('path')
  if (!dir || !isAbsolute(dir)) throw new BadRequest('path must be an absolute path')
  if (method === 'GET') return [200, await worktreeStatus(dir).catch(badRequest)]
  if (method === 'DELETE') {
    if (manager.in(dir).some((s) => s.running)) throw new BadRequest('A chat is still working in this worktree')
    if (terminals.terminals.some((t) => t.root === dir)) throw new BadRequest('Close its terminals first')
    for (const s of manager.in(dir)) s.close()
    await removeWorktree(dir).catch(badRequest)
    broadcast({ type: 'sessions_changed' })
    return [204, null]
  }
  return undefined
}

/** Terminal routes. Live I/O goes over the WebSocket; these are the one-off actions. */
async function terminalsApi(method: string, path: string, req: IncomingMessage): Promise<[number, unknown] | undefined> {
  if (path === '/api/terminals') {
    if (method === 'GET') return [200, terminals.terminals]
    if (method === 'POST') {
      const { cwd, command, cols, rows } = await readJson(req)
      if (typeof cwd !== 'string' || !isAbsolute(cwd)) throw new BadRequest('cwd must be an absolute path')
      if (command !== undefined && typeof command !== 'string') throw new BadRequest('command must be a string')
      return [201, await terminals.create({ cwd, command: command || undefined, cols, rows }).catch(badRequest)]
    }
  }
  const m = path.match(/^\/api\/terminals\/([0-9a-f]+)(?:\/(restart))?$/)
  if (!m) return undefined
  const [, id, action] = m
  if (!terminals.get(id)) return [404, { error: 'No such terminal' }]
  if (method === 'POST' && action === 'restart') return [200, await terminals.restart(id)]
  if (method === 'DELETE' && !action) return (await terminals.remove(id), [204, null])
  return undefined
}

const badRequest = (err: Error): never => {
  throw new BadRequest(err.message)
}

const roots = new Map<string, string>()

const found = (card: unknown): [number, unknown] => (card ? [200, card] : [404, { error: 'No such card' }])

/** Tells every open tab to refetch once a write succeeds. */
function changed(result: [number, unknown]): [number, unknown] {
  if (result[0] < 300) broadcast({ type: 'cards_changed' })
  return result
}

async function readJson(req: IncomingMessage): Promise<any> {
  let body = ''
  for await (const chunk of req) body += chunk
  try {
    return body ? JSON.parse(body) : {}
  } catch {
    throw new BadRequest('Invalid JSON')
  }
}

const MIME: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
}

/**
 * Only the page this server serves may use it. Without auth, any website the
 * user visits could otherwise POST a command into a terminal or open the
 * WebSocket and type into one. The Host check stops DNS rebinding (a hostile
 * name resolving to 127.0.0.1); the Origin check stops cross-site requests.
 * Requests with no Origin (curl, same-origin GETs) are allowed.
 */
const LOCAL_NAMES = new Set(['localhost', '127.0.0.1', '[::1]', HOST])

function sameOrigin(req: IncomingMessage): boolean {
  const host = req.headers.host
  if (!host || !LOCAL_NAMES.has(new URL(`http://${host}`).hostname)) return false
  const origin = req.headers.origin
  if (!origin) return true
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x')
  const json = (status: number, body: unknown) => {
    if (status === 204) return void res.writeHead(204).end()
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  if (!sameOrigin(req)) return json(403, { error: 'Cross-origin requests are not allowed' })
  try {
    if (url.pathname === '/api/config') return json(200, { defaultCwd: WORKSPACE_DIR, scratchCwd: SCRATCH_DIR })
    if (url.pathname.startsWith('/api/')) {
      if (url.pathname === '/api/sessions') return json(200, await sessionList())
      if (url.pathname === '/api/models') return json(200, await listModels())
      if (url.pathname === '/api/workspace') {
        const cwd = url.searchParams.get('cwd')
        if (!cwd) throw new BadRequest('cwd is required')
        if (!roots.has(cwd)) roots.set(cwd, workspaceRoot(cwd))
        return json(200, { root: roots.get(cwd) })
      }
      const sessions = await sessionsApi(req.method ?? 'GET', url.pathname, req)
      if (sessions) return json(...sessions)
      const worktrees = await worktreesApi(req.method ?? 'GET', url.pathname, url)
      if (worktrees) return json(...worktrees)
      const terms = await terminalsApi(req.method ?? 'GET', url.pathname, req)
      if (terms) return json(...terms)
      const cards = await cardsApi(req.method ?? 'GET', url.pathname, req)
      if (cards) return json(...cards)
      return json(404, { error: 'Not found' })
    }
    // Production: serve the built client, falling back to index.html for client routes.
    let file = join(DIST, url.pathname)
    if (!file.startsWith(DIST) || !existsSync(file) || statSync(file).isDirectory()) file = join(DIST, 'index.html')
    if (!existsSync(file)) return json(404, { error: 'Client not built; run `pnpm build` or use `pnpm dev`' })
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' })
    createReadStream(file).pipe(res)
  } catch (err) {
    if (err instanceof BadRequest) return json(400, { error: err.message })
    json(500, { error: err instanceof Error ? err.message : String(err) })
  }
})

const wss = new WebSocketServer({ noServer: true })

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', 'http://x')
  if (url.pathname !== '/ws' || !sameOrigin(req)) {
    socket.write(url.pathname !== '/ws' ? 'HTTP/1.1 404 Not Found\r\n\r\n' : 'HTTP/1.1 403 Forbidden\r\n\r\n')
    socket.destroy()
    return
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws))
})

wss.on('connection', (ws: WebSocket) => {
  sockets.add(ws)
  // Before the host has said hello the list is unknown, not empty; it's broadcast once it arrives.
  if (terminals.known) send(ws, { type: 'terminals', terminals: terminals.terminals })
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
    for (const set of termViewers.values()) set.delete(ws)
  })
})

server.listen(PORT, HOST, () => {
  console.log(`badger server on http://${HOST}:${PORT} (workspace ${WORKSPACE_DIR})`)
})

// Terminals live in a separate process and outlive this one; connect now so the list is ready.
terminals.connect().catch((err) => console.error(err.message))

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
