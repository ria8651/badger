import { createReadStream, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage } from 'node:http'
import { homedir, hostname } from 'node:os'
import { extname, isAbsolute, join, resolve } from 'node:path'
import { WebSocketServer, type WebSocket } from 'ws'
import { IMAGE_TYPES, type AnswerDraft, type ClientEvent, type DraftAttachments, type ServerEvent, type SessionSummary } from '../shared/protocol.ts'
import { Attention } from './attention.ts'
import { cardContext, markSeen } from './boardTools.ts'
import { type Actor, BadRequest, type Draft, Store } from './db.ts'
import { LOCAL, Machines, type Connection } from './machines.ts'
import { memoryLinks, wsLink } from './peer.ts'
import { Runner } from './runner.ts'
import { PROTOCOL_HEADER, RUNNER_PROTOCOL, type ChatInfo, type HubApi, type LiveSnapshot, type RunnerEvent, type TranscriptLines } from './runnerProtocol.ts'
import { shellEnv } from './terminals.ts'
import { suggestTitle } from './titles.ts'
import { Transcripts, transcriptModel } from './transcripts.ts'
import { AccountLimits } from './usage.ts'
import { prepareScratch } from './workspace.ts'

// Terminals get the environment Badger was started with, before .env adds PORT and friends.
const startEnv = shellEnv(process.env)
loadDotEnv()

/** How often plan usage is read again while a tab is open, besides after each turn. */
const ACCOUNT_POLL_MS = 5 * 60 * 1000
/** How long the chat list waits on a machine to say which folders are gone. */
const GONE_TIMEOUT_MS = 3000
/** How often connected runners are pinged; one that hasn't answered the last ping by the next is dropped. */
const RUNNER_PING_MS = 30 * 1000

const PORT = Number(process.env.PORT ?? 3001)
const HOST = process.env.HOST ?? '127.0.0.1'
const WORKSPACE_DIR = resolve(process.env.WORKSPACE_DIR ?? process.cwd())
const DIST = resolve('dist')
const DATA_DIR = resolve(process.env.DATA_DIR ?? 'data')
// Folderless chats run here. Outside DATA_DIR, which defaults to inside this repo.
const SCRATCH_DIR = resolve(process.env.SCRATCH_DIR || join(homedir(), '.badger', 'scratch'))

mkdirSync(WORKSPACE_DIR, { recursive: true })
prepareScratch(SCRATCH_DIR)

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
const transcripts = new Transcripts(store.db)
/** Changes made through the REST API and WebSocket, i.e. by someone in the browser. */
const UI: Actor = { source: 'ui' }
const cardsChanged = <T>(value: T): T => {
  broadcast({ type: 'cards_changed' })
  return value
}

// The hub's own machine starts out named after the host; it can be renamed on the Machines page.
const machines = new Machines(store.db, hostname().split('.')[0], {
  onChange: (connection, id) => machineChanged(connection, id),
  onEvent: (machine, event) => runnerEvent(machine, event),
})
const attention = new Attention(store, () => machines.allLive().flatMap((s) => (s.waiting ? [s.id] : [])), broadcast)
const account = new AccountLimits(
  () => (machines.get(LOCAL) ?? machines.online()[0])?.peer.remote.accountUsage(),
  (u) => broadcast({ type: 'account_usage', usage: u }),
)

/** The machine a chat runs on, if it's connected. */
function runnerFor(sessionId: string): Connection | undefined {
  const machine = machines.machineOf(sessionId)
  return machine ? machines.get(machine) : undefined
}

/** Any connected runner, the hub's own first, for questions about the account rather than a chat. */
const anyRunner = () => machines.get(LOCAL) ?? machines.online()[0]

/** Tells one viewer, or all of them, how full the chat's context is. */
function sendContext(sessionId: string, ws?: WebSocket): void {
  const runner = runnerFor(sessionId)
  if (!runner) return
  runner.peer.remote
    .contextUsage(sessionId)
    .then((u) => {
      if (!u) return
      const event: ServerEvent = { type: 'context', sessionId, usage: u }
      if (ws) send(ws, event)
      else broadcast(event)
    })
    .catch((err) => console.error(`Reading context usage for ${sessionId} failed:`, err instanceof Error ? err.message : err))
}

// Limits move with use on other machines too, so read them now and then while anyone's looking.
setInterval(() => sockets.size && void account.refresh(), ACCOUNT_POLL_MS).unref()

// ── What runners tell the hub ──

function runnerEvent(machine: Connection, event: RunnerEvent): void {
  switch (event.type) {
    case 'session':
      broadcast(event.event)
      attention.see(event.event)
      return
    case 'live':
      // A chat started, closed, or started or finished working.
      broadcast({ type: 'sessions_changed' })
      attention.update()
      return
    case 'turn_end':
      sendContext(event.sessionId)
      void account.refresh()
      return
    case 'terminals':
      broadcastTerminals()
      return
    case 'term_output': {
      const id = `${machine.id}.${event.id}`
      for (const [ws, v] of termViewers.get(id) ?? []) if (v.live) send(ws, { type: 'term_output', id, data: event.data })
      return
    }
  }
}

/** A runner connected or went away. Its chats' viewers get a fresh snapshot: running, read-only, or back again. */
function machineChanged(connection: Connection | undefined, id: string): void {
  broadcast({ type: 'machines', machines: machines.list() })
  broadcast({ type: 'sessions_changed' })
  attention.update()
  broadcastTerminals()
  for (const [sessionId, set] of viewers) {
    if (machines.machineOf(sessionId) !== id) continue
    for (const ws of set) void sendSnapshot(ws, sessionId)
  }
  if (!connection) return
  // Its terminals' viewers start again from a snapshot.
  for (const [tid, set] of termViewers) {
    if (!tid.startsWith(`${id}.`)) continue
    for (const [ws, v] of set) {
      v.live = false
      snapshotTerminal(ws, tid)
    }
  }
  void account.refresh()
}

/** What runners can ask of the hub: the board for Claude's tools, recording children, and taking their transcripts. */
function hubApi(machine: string): Omit<HubApi, 'hello'> {
  return {
    cards: () => store.cards(),
    card: (id) => store.card(id),
    createCard: (input, actor) => cardsChanged(store.createCard(input, actor)),
    updateCard: (id, patch, actor) => cardsChanged(store.updateCard(id, patch, actor)),
    deleteCard: (id, actor) => cardsChanged(store.deleteCard(id, actor)),
    linkSession: (cardId, sessionId, actor) => cardsChanged(store.linkSession(cardId, sessionId, actor)),
    setArchived: (sessionId, archived, actor) => store.setArchived(sessionId, archived, actor),
    archivedIds: () => [...store.archivedIds()],
    cardContext: (sessionId) => cardContext(store, sessionId),
    markSeen: (sessionId, cardId) => markSeen(store, sessionId, cardId),
    chatInfo,
    addChild: (child) => {
      // Children run on their parent's machine.
      machines.claim(child.sessionId, machine)
      store.addChild(child)
    },
    transcriptState: (files) => transcripts.state(files),
    transcriptLines: (batch) => takeLines(machine, batch),
  }
}

async function chatInfo(ids: string[]): Promise<ChatInfo[]> {
  const where = machines.machinesOf(ids)
  return Promise.all(
    ids.map(async (id) => {
      const info = await transcripts.info(id)
      const machine = where.get(id)
      return {
        id,
        title: info?.customTitle || info?.summary || info?.firstPrompt,
        cwd: machines.live(id)?.cwd ?? info?.cwd,
        machine,
        machineName: machine && machines.name(machine),
      }
    }),
  )
}

/** A runner's transcript lines. A chat's lines only come from its own machine. */
function takeLines(machine: string, batch: TranscriptLines) {
  if (machines.claim(batch.sessionId, machine) !== machine) return { ...transcripts.state([batch])[0], ignored: true }
  const result = store.transaction(() => transcripts.append(batch))
  if (result.bytes === batch.bytes && (batch.lines.length || batch.reset)) transcriptChanged(batch.sessionId)
  return result
}

let listTimer: ReturnType<typeof setTimeout> | undefined
const stale = new Set<string>()
let staleTimer: ReturnType<typeof setTimeout> | undefined

/**
 * A chat's transcript grew on the hub. The list may have a new title or time.
 * Viewers of a chat with no live process are watching history arrive, e.g.
 * after its machine reconnects, so they get it again; a live chat's viewers
 * already have it from the process.
 */
function transcriptChanged(sessionId: string): void {
  listTimer ??= setTimeout(() => {
    listTimer = undefined
    broadcast({ type: 'sessions_changed' })
  }, 1000)
  if (machines.live(sessionId) || !viewers.get(sessionId)?.size) return
  stale.add(sessionId)
  staleTimer ??= setTimeout(() => {
    staleTimer = undefined
    for (const id of stale) for (const ws of viewers.get(id) ?? []) void sendSnapshot(ws, id)
    stale.clear()
  }, 500)
}

// ── Terminals: which sockets are watching which terminal ──

/**
 * Per terminal, the sockets viewing it and how many views each has open. A
 * socket isn't live until its snapshot goes out: output before then is
 * already in the snapshot.
 */
const termViewers = new Map<string, Map<WebSocket, { views: number; live: boolean }>>()

function broadcastTerminals(): void {
  if (!machines.terminalsKnown()) return
  const list = machines.terminals()
  broadcast({ type: 'terminals', terminals: list })
  for (const id of termViewers.keys()) if (!list.some((t) => t.id === id)) termViewers.delete(id)
}

/** Every subscribe gets a fresh snapshot, which also resets any view of it the socket already has. */
function subscribeTerminal(ws: WebSocket, id: string): void {
  let viewers = termViewers.get(id)
  if (!viewers) termViewers.set(id, (viewers = new Map()))
  const v = viewers.get(ws) ?? { views: 0, live: false }
  viewers.set(ws, { views: v.views + 1, live: false })
  snapshotTerminal(ws, id)
}

/** The reply is handled in order with the terminal's output, so nothing falls between the snapshot and going live. */
function snapshotTerminal(ws: WebSocket, id: string): void {
  const done = (data: string | undefined) => {
    const current = termViewers.get(id)?.get(ws)
    if (!current || current.live) return
    current.live = true
    send(ws, { type: 'term_snapshot', id, data: data ?? '' })
  }
  const t = machines.terminal(id)
  if (!t) return done(undefined)
  t.machine.peer.request('termSnapshot', [t.id], (err, data) => done(err ? undefined : data))
}

function unsubscribeTerminal(ws: WebSocket, id: string): void {
  const v = termViewers.get(id)?.get(ws)
  if (v && --v.views <= 0) termViewers.get(id)!.delete(ws)
}

// ── Chats ──

/**
 * Sends a viewer the chat's history and, if it's live, its process's state.
 * The history comes from the hub's copy of the transcript; the process adds
 * its own turns, which may be newer. The live part is taken last and sent the
 * moment it arrives, so the chat's events after it reach the viewer after it.
 */
async function sendSnapshot(ws: WebSocket, sessionId: string): Promise<void> {
  const { text: draft, attachments: draftAttachments } = store.draft(sessionId)
  const children = store.children(sessionId)
  const machine = machines.machineOf(sessionId)
  const [history, info] = machine ? await Promise.all([transcripts.transcript(sessionId), transcripts.info(sessionId)]) : [[], undefined]
  const runner = machine ? machines.get(machine) : undefined
  const base = { type: 'snapshot' as const, sessionId, machine, draft, draftAttachments, children }
  const done = (live: LiveSnapshot | null, gone: boolean) => {
    if (!live) {
      return send(ws, {
        ...base,
        messages: history,
        running: false,
        mode: 'auto',
        model: transcriptModel(history),
        cwd: info?.cwd,
        gone,
        permissions: [],
        bashOutput: {},
        background: [],
      })
    }
    // History holds earlier processes' turns; the live list holds this process's, in order.
    const seen = new Set(live.messages.map((m) => m.uuid))
    const messages = [...history.filter((m) => !seen.has(m.uuid) && !seen.has(m.after_uuid as string)), ...live.messages]
    send(ws, { ...base, ...live, messages })
  }
  if (!runner) return done(null, false)
  const gone = info?.cwd ? (await runner.peer.remote.inaccessible([info.cwd]).catch(() => [])).length > 0 : false
  runner.peer.request('liveSnapshot', [sessionId], (err, live) => done(err ? null : live, gone))
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
      await sendSnapshot(ws, event.sessionId)
      // After the snapshot: it can mean starting a process, which shouldn't hold up the transcript.
      sendContext(event.sessionId, ws)
      return
    }
    case 'unsubscribe':
      viewers.get(event.sessionId)?.delete(ws)
      return
    case 'send': {
      const { pastes, images } = checkAttachments(event)
      if (event.model !== undefined && typeof event.model !== 'string') throw new BadRequest('model must be a string')
      if (event.machine !== undefined && typeof event.machine !== 'string') throw new BadRequest('machine must be a string')
      // A chat stays where it started; a new one goes where it was asked to.
      const machine = machines.machineOf(event.sessionId) ?? (event.machine || LOCAL)
      const runner = machines.require(machine)
      // Picking an archived chat back up brings it back to the sidebar.
      store.setArchived(event.sessionId, false, UI)
      attention.mark(event.sessionId, false)
      // Sending empties the composer in every tab, not just the one that sent.
      saveDraft(ws, event.sessionId, { text: '', attachments: { pastes: [], images: [] } })
      machines.claim(event.sessionId, machine)
      await runner.peer.remote.send(
        event.sessionId,
        { cwd: event.cwd, mode: event.mode, model: event.model, worktree: event.worktree },
        event.text,
        pastes,
        images,
      )
      return
    }
    case 'draft':
      if (event.text !== undefined && typeof event.text !== 'string') throw new BadRequest('text must be a string')
      saveDraft(ws, event.sessionId, { text: event.text, attachments: event.attachments && checkAttachments(event.attachments) })
      return
    case 'interrupt': {
      // Stopping a chat stops whatever it's waiting on too. Children run on their parent's machine.
      const runner = runnerFor(event.sessionId)
      if (!runner) return
      const ids = [event.sessionId, ...Object.values(store.children(event.sessionId))]
      await Promise.all(ids.map((id) => runner.peer.remote.interrupt(id)))
      return
    }
    case 'stop_task':
      await runnerFor(event.sessionId)?.peer.remote.stopTask(event.sessionId, event.taskId)
      return
    case 'background_task':
      if (event.toolUseId !== undefined && typeof event.toolUseId !== 'string') throw new BadRequest('toolUseId must be a string')
      await runnerFor(event.sessionId)?.peer.remote.backgroundTask(event.sessionId, event.toolUseId)
      return
    case 'set_mode':
      await runnerFor(event.sessionId)?.peer.remote.setMode(event.sessionId, event.mode)
      return
    case 'set_model':
      if (typeof event.model !== 'string') throw new BadRequest('model must be a string')
      // A chat that isn't running takes the model with its next message.
      await runnerFor(event.sessionId)?.peer.remote.setModel(event.sessionId, event.model)
      return
    case 'permission':
      await runnerFor(event.sessionId)?.peer.remote.resolvePermission(event.sessionId, event.requestId, event.decision, event.message, event.updatedInput)
      return
    case 'answer_draft': {
      const answers = checkAnswers(event.answers)
      // Shown to the chat's other viewers; the one answering already has it.
      if (!(await runnerFor(event.sessionId)?.peer.remote.draftAnswers(event.sessionId, event.requestId, answers))) return
      const update: ServerEvent = { type: 'answer_draft', sessionId: event.sessionId, requestId: event.requestId, answers }
      for (const other of viewers.get(event.sessionId) ?? []) if (other !== ws) send(other, update)
      return
    }
    case 'seen':
      attention.mark(event.sessionId, false)
      return
    case 'term_subscribe':
      subscribeTerminal(ws, event.id)
      return
    case 'term_unsubscribe':
      unsubscribeTerminal(ws, event.id)
      return
    case 'term_input': {
      const t = machines.terminal(event.id)
      t?.machine.peer.emit({ type: 'term_input', id: t.id, data: event.data })
      return
    }
    case 'term_resize': {
      const t = machines.terminal(event.id)
      t?.machine.peer.emit({ type: 'term_resize', id: t.id, cols: event.cols, rows: event.rows })
      return
    }
  }
}

// ── HTTP ──

async function sessionList(): Promise<SessionSummary[]> {
  const infos = await transcripts.list(200)
  const archived = store.archivedIds()
  // Children show inside the chat that started them.
  const childIds = store.childIds()
  const listed = infos.filter((s) => !childIds.has(s.sessionId))
  const where = machines.machinesOf(listed.map((s) => s.sessionId))
  const gone = await goneFolders(listed.flatMap((s) => (s.cwd && !machines.live(s.sessionId) ? [{ machine: where.get(s.sessionId), cwd: s.cwd }] : [])))
  const summaries: SessionSummary[] = listed.map((s) => {
    const machine = where.get(s.sessionId)
    const live = machines.live(s.sessionId)
    return {
      id: s.sessionId,
      title: s.customTitle || s.summary || s.firstPrompt || 'Untitled',
      // A live chat may have moved into a worktree since its transcript was last written.
      cwd: live?.cwd ?? s.cwd,
      machine,
      lastModified: s.lastModified,
      running: !!live?.running,
      archived: archived.has(s.sessionId),
      gone: !live && !!s.cwd && !!gone.get(machine ?? '')?.has(s.cwd),
    }
  })
  // A brand-new live session may not have a transcript here yet.
  for (const runner of machines.online()) {
    for (const live of runner.live.values()) {
      if (childIds.has(live.id) || summaries.some((s) => s.id === live.id)) continue
      summaries.unshift({ id: live.id, title: 'New chat', cwd: live.cwd, machine: runner.id, lastModified: Date.now(), running: live.running, archived: false })
    }
  }
  return summaries
}

/** Which of these folders are gone, by machine, asking each connected machine once. Offline machines' folders can't be checked, so they aren't. */
async function goneFolders(folders: { machine?: string; cwd: string }[]): Promise<Map<string, Set<string>>> {
  const byMachine = new Map<string, Set<string>>()
  for (const f of folders) if (f.machine) byMachine.set(f.machine, (byMachine.get(f.machine) ?? new Set()).add(f.cwd))
  const out = new Map<string, Set<string>>()
  await Promise.all(
    [...byMachine].map(async ([machine, dirs]) => {
      const runner = machines.get(machine)
      if (!runner) return
      const timeout = new Promise<string[]>((r) => setTimeout(() => r([]), GONE_TIMEOUT_MS).unref())
      out.set(machine, new Set(await Promise.race([runner.peer.remote.inaccessible([...dirs]).catch(() => []), timeout])))
    }),
  )
  return out
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
  // The title goes in the transcript, on the chat's machine, where the CLI's /resume sees it too. It comes back with the transcript.
  if (action === 'title' && method === 'PUT') {
    const { title } = await readJson(req)
    if (typeof title !== 'string' || !title.trim()) throw new BadRequest('title is required')
    const machine = machines.machineOf(id)
    if (!machine) return [404, { error: 'No such chat' }]
    await machines.require(machine).peer.remote.rename(id, title.trim())
    return [204, null]
  }
  if (action === 'title/suggest' && method === 'POST') {
    const info = await transcripts.info(id)
    if (!info) return [404, { error: 'No such chat' }]
    const current = info.customTitle || info.summary || info.firstPrompt || ''
    const card = store.cards().find((c) => c.sessionIds.includes(id))
    return [200, { title: await suggestTitle(id, current, card, SCRATCH_DIR, transcripts.store).catch(badRequest) }]
  }
  return undefined
}

/** Machine routes: the list, adding one (its token is shown once) and removing one. */
async function machinesApi(method: string, path: string, req: IncomingMessage): Promise<[number, unknown] | undefined> {
  if (path === '/api/machines') {
    if (method === 'GET') return [200, machines.list()]
    if (method === 'POST') {
      const { name } = await readJson(req)
      const created = machines.create(name)
      broadcast({ type: 'machines', machines: machines.list() })
      return [201, created]
    }
  }
  const token = path.match(/^\/api\/machines\/([a-z0-9-]+)\/token$/)
  if (token && method === 'POST') {
    const issued = machines.resetToken(token[1])
    broadcast({ type: 'machines', machines: machines.list() })
    return [200, issued]
  }
  const m = path.match(/^\/api\/machines\/([a-z0-9-]+)$/)
  if (m && method === 'PATCH') {
    const { name } = await readJson(req)
    const machine = machines.rename(m[1], name)
    broadcast({ type: 'machines', machines: machines.list() })
    // Chats and terminals show it.
    broadcast({ type: 'sessions_changed' })
    return [200, machine]
  }
  if (m && method === 'DELETE') {
    if (!machines.remove(m[1])) return [404, { error: 'No such machine' }]
    broadcast({ type: 'machines', machines: machines.list() })
    return [204, null]
  }
  return undefined
}

/** The connected runner for a machine named in a request, defaulting to the hub's own. */
function machineParam(value: unknown): Connection {
  if (value !== undefined && value !== null && typeof value !== 'string') throw new BadRequest('machine must be a string')
  return machines.require(value || LOCAL)
}

/** Worktree routes, by machine and path. Making them is Claude Code's job (--worktree); these look and clean up. */
async function worktreesApi(method: string, path: string, url: URL): Promise<[number, unknown] | undefined> {
  if (path !== '/api/worktree') return undefined
  const dir = url.searchParams.get('path')
  if (!dir || !isAbsolute(dir)) throw new BadRequest('path must be an absolute path')
  const runner = machineParam(url.searchParams.get('machine'))
  if (method === 'GET') return [200, await runner.peer.remote.worktreeStatus(dir)]
  if (method === 'DELETE') {
    await runner.peer.remote.removeWorktree(dir)
    broadcast({ type: 'sessions_changed' })
    return [204, null]
  }
  return undefined
}

/** Terminal routes. Live I/O goes over the WebSocket; these are the one-off actions. */
async function terminalsApi(method: string, path: string, req: IncomingMessage): Promise<[number, unknown] | undefined> {
  if (path === '/api/terminals') {
    if (method === 'GET') return [200, machines.terminals()]
    if (method === 'POST') {
      const { cwd, command, cols, rows, machine } = await readJson(req)
      if (typeof cwd !== 'string' || !isAbsolute(cwd)) throw new BadRequest('cwd must be an absolute path')
      if (command !== undefined && typeof command !== 'string') throw new BadRequest('command must be a string')
      const runner = machineParam(machine)
      return [201, machines.upsertTerminal(runner, await runner.peer.remote.termCreate({ cwd, command: command || undefined, cols, rows }))]
    }
  }
  const m = path.match(/^\/api\/terminals\/([a-z0-9-]+\.[0-9a-f]+)(?:\/(restart))?$/)
  if (!m) return undefined
  const [, id, action] = m
  const t = machines.terminal(id)
  if (!t || !t.machine.terminals.some((x) => x.id === t.id)) return [404, { error: 'No such terminal' }]
  if (method === 'POST' && action === 'restart') return [200, machines.upsertTerminal(t.machine, await t.machine.peer.remote.termRestart(t.id))]
  if (method === 'DELETE' && !action) {
    await t.machine.peer.remote.termRemove(t.id)
    t.machine.terminals = t.machine.terminals.filter((x) => x.id !== t.id)
    return [204, null]
  }
  return undefined
}

const badRequest = (err: Error): never => {
  throw new BadRequest(err.message)
}

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
 * WebSocket and type into one. The Origin check stops cross-site requests.
 * Requests with no Origin (curl, same-origin GETs) are allowed.
 *
 * Bound to loopback, the Host check also stops DNS rebinding (a hostile name
 * resolving to 127.0.0.1). Bound wider, whatever fronts the port (an auth
 * proxy) is the guard: a rebound name reaches the proxy without a session.
 *
 * Runners don't come through here: they have a token instead (see `/runner`).
 */
const LOCAL_NAMES = new Set(['localhost', '127.0.0.1', '[::1]'])
const CHECK_HOST = LOCAL_NAMES.has(HOST) || HOST === '::1'

function sameOrigin(req: IncomingMessage): boolean {
  const host = req.headers.host
  if (!host || (CHECK_HOST && !LOCAL_NAMES.has(new URL(`http://${host}`).hostname))) return false
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
      if (url.pathname === '/api/models') {
        const runner = anyRunner()
        return json(200, runner ? await runner.peer.remote.models() : [])
      }
      if (url.pathname === '/api/workspace') {
        const cwd = url.searchParams.get('cwd')
        if (!cwd) throw new BadRequest('cwd is required')
        return json(200, { root: await machineParam(url.searchParams.get('machine')).peer.remote.workspaceRoot(cwd) })
      }
      const method = req.method ?? 'GET'
      const result =
        (await sessionsApi(method, url.pathname, req)) ??
        (await machinesApi(method, url.pathname, req)) ??
        (await worktreesApi(method, url.pathname, url)) ??
        (await terminalsApi(method, url.pathname, req)) ??
        (await cardsApi(method, url.pathname, req))
      return result ? json(...result) : json(404, { error: 'Not found' })
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
// Transcript lines can be big (pasted images), and a chunk of them bigger.
const runnerWss = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024 * 1024 })

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', 'http://x')
  const refuse = (status: string, why = '') => {
    socket.write(`HTTP/1.1 ${status}\r\ncontent-type: text/plain\r\nconnection: close\r\n\r\n${why}`)
    socket.destroy()
  }
  if (url.pathname === '/runner') {
    // A runner: no browser session, so it's let through the proxy in front and has a token instead.
    const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')
    const machine = token ? machines.byToken(token) : undefined
    if (!machine) return refuse('401 Unauthorized', 'Unknown or revoked runner token')
    if (req.headers[PROTOCOL_HEADER] !== String(RUNNER_PROTOCOL)) {
      return refuse('426 Upgrade Required', `This hub speaks runner protocol v${RUNNER_PROTOCOL}, the runner v${req.headers[PROTOCOL_HEADER] ?? '?'}. Update whichever is older.`)
    }
    return runnerWss.handleUpgrade(req, socket, head, (ws) => connectRunner(machine, ws))
  }
  if (url.pathname !== '/ws') return refuse('404 Not Found')
  if (!sameOrigin(req)) return refuse('403 Forbidden')
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws))
})

/** A remote runner's connection, dropped if it stops answering pings (a laptop that went to sleep mid-connection). */
function connectRunner(machine: string, ws: WebSocket): void {
  let alive = true
  ws.on('pong', () => (alive = true))
  const ping = setInterval(() => {
    if (!alive) return ws.terminate()
    alive = false
    ws.ping()
  }, RUNNER_PING_MS)
  ws.on('close', () => clearInterval(ping))
  machines.attach(machine, wsLink(ws), hubApi)
}

wss.on('connection', (ws: WebSocket) => {
  sockets.add(ws)
  send(ws, { type: 'machines', machines: machines.list() })
  // Before every machine's PTY host has said hello the list is unknown, not empty; it's broadcast once they have.
  if (machines.terminalsKnown()) send(ws, { type: 'terminals', terminals: machines.terminals() })
  const latest = account.latest()
  if (latest) send(ws, { type: 'account_usage', usage: latest })
  void account.refresh()
  send(ws, { type: 'attention', chats: attention.chats() })
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

// The hub's own machine: a runner in this process, over an in-memory link.
const runner = new Runner({ workspaceDir: WORKSPACE_DIR, scratchDir: SCRATCH_DIR, dataDir: DATA_DIR, env: startEnv })
const [hubEnd, runnerEnd] = memoryLinks()
machines.attach(LOCAL, hubEnd, hubApi)
runner.connect(runnerEnd).catch((err) => console.error('The hub’s own runner failed to start:', err))

server.listen(PORT, HOST, () => {
  console.log(`badger server on http://${HOST}:${PORT} (workspace ${WORKSPACE_DIR})`)
})

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    runner.closeAll()
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
