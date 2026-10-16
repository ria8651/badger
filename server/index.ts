import { randomUUID } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage } from 'node:http'
import { homedir } from 'node:os'
import { extname, isAbsolute, join, resolve } from 'node:path'
import { WebSocketServer, type WebSocket } from 'ws'
import { z } from 'zod'
import { renderMoveNote, splitMoveNote } from '../shared/forkNote.ts'
import { IMAGE_TYPES, type AnswerDraft, type ClientEvent, type DraftAttachments, type ServerEvent, type SessionSummary } from '../shared/protocol.ts'
import { Attention } from './attention.ts'
import { BRIDGE_PATH, Bridges } from './bridge.ts'
import { boardOps, cardContext, contextSeen, type ChatInfo } from './boardTools.ts'
import { type Actor, BadRequest, type Draft, Store } from './db.ts'
import { forkTranscript } from './fork.ts'
import { LOCAL, Machines, mismatch, type Connection } from './machines.ts'
import { OpError, type Op } from './ops.ts'
import { memoryLinks, wsLink } from './peer.ts'
import { proxyPreview, proxyPreviewUpgrade, previewPort } from './preview.ts'
import { bridgeOps } from './previewTools.ts'
import { Runner } from './runner.ts'
import {
  PROTOCOL_HEADER,
  RUNNER_MAX_FRAME,
  RUNNER_PROTOCOL,
  SESSION_EVENTS,
  isUuid,
  type HubApi,
  type LiveSnapshot,
  type RunnerEvent,
  type TranscriptLines,
} from './runnerProtocol.ts'
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
/** How long a machine's answer about a folder being gone is used for, rather than asking again on every list. */
const GONE_TTL_MS = 30 * 1000
/** A running chat's transcript changes the list (its time, now and then its title) at most this often; starting and stopping show at once. */
const LIVE_LIST_MS = 15 * 1000
/**
 * How long opening a chat or terminal waits on its machine before showing what
 * the hub has. A laptop gone to sleep can leave its connection half-open,
 * answering nothing until the ping drops it.
 */
const QUICK_TIMEOUT_MS = 10 * 1000
/** Changes to the chat list, terminals or runners within this long go out to tabs as one, however often runners send them. */
const LIST_DEBOUNCE_MS = 200
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

/** Runs `fn` once, shortly, however many times this is called meanwhile. */
function debounced(fn: () => void, ms = LIST_DEBOUNCE_MS): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  return () => {
    timer ??= setTimeout(() => {
      timer = undefined
      fn()
    }, ms)
  }
}

/** Tells every tab to fetch the chat list again; each fetch asks every machine about its folders. */
const sessionsChanged = debounced(() => broadcast({ type: 'sessions_changed' }))
const machinesChanged = debounced(() => broadcast({ type: 'machines', machines: machines.list() }))

/**
 * Where each browser reaches previews, with `{port}` in it. Claude gets the
 * latest that isn't localhost when there is one, since that works from
 * anywhere, and the user may be on their phone.
 */
const previewUrls = new Map<WebSocket, string>()
const previewUrl = () => {
  const urls = [...previewUrls.values()].reverse()
  return urls.find((u) => !/\{port\}\.localhost\b/.test(u)) ?? urls[0]
}

const store = new Store(DATA_DIR, sessionsChanged)
const transcripts = new Transcripts(store.db)
/** Changes made through the REST API and WebSocket, i.e. by someone in the browser. */
const UI: Actor = { source: 'ui' }
const bridges = new Bridges()
const cardsChanged = () => broadcast({ type: 'cards_changed' })

/**
 * The ops that run here rather than beside Claude: the board, and the bridge
 * into previews of the hub's own machine. Runners' tools and scripts call
 * them through runOp.
 */
const bridge = bridgeOps(bridges)
const hubOps: Op[] = [...boardOps({ store, onChange: cardsChanged, chats: chatInfo }), ...bridge]
const hubOnly = new Set(bridge.map((o) => o.script))

const machines: Machines = new Machines(store.db, {
  onChange: (connection, id) => machineChanged(id, !!connection),
  onEvent: (machine, event) => runnerEvent(machine, event),
})
const attention = new Attention(store, () => machines.allLive().flatMap((s) => (s.waiting ? [s.id] : [])), broadcast)
const account = new AccountLimits(
  () => anyRunner()?.peer.remote.accountUsage(),
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
  runnerFor(sessionId)
    ?.peer.remote.contextUsage(sessionId)
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

/** A chat's event from a runner (already checked to be a kind a chat emits), if the chat is on that runner's machine. */
function sessionEvent(machine: string, event: ServerEvent): ServerEvent | undefined {
  if (!('sessionId' in event) || !SESSION_EVENTS.includes(event.type as never) || !machines.owns(machine, event.sessionId)) return undefined
  if (event.type === 'child_started' && (!isUuid(event.childId) || store.parentOf(event.childId) !== event.sessionId)) return undefined
  return event
}

function runnerEvent(machine: Connection, event: RunnerEvent): void {
  switch (event.type) {
    case 'session': {
      const e = sessionEvent(machine.id, event.event)
      if (!e) return
      broadcast(e)
      attention.see(e)
      return
    }
    case 'live':
      // Turns that ended while the hub wasn't listening, e.g. with the runner offline, still want reading.
      for (const s of event.sessions) if (machines.owns(machine.id, s.id)) turnsEnded(s.id, s.turns)
      // A chat started, closed, or started or finished working.
      sessionsChanged()
      machinesChanged()
      attention.update()
      return
    case 'turn_end':
      if (!machines.owns(machine.id, event.sessionId)) return
      turnsSeen.set(event.sessionId, event.turns)
      attention.turnEnded(event.sessionId, event.queued)
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

/** Per live chat, how many of its turns had ended when the hub last heard. */
const turnsSeen = new Map<string, number>()

/** A chat's runner says this many of its turns have ended; any the hub missed mark it unread. */
function turnsEnded(sessionId: string, turns: number): void {
  const seen = turnsSeen.get(sessionId)
  turnsSeen.set(sessionId, turns)
  // Unknown since the hub started; fewer since the runner restarted. Either way there's nothing to compare.
  if (seen !== undefined && turns > seen) attention.turnEnded(sessionId, false)
}

/** Machines whose runner was connected, last we looked. */
const wasOnline = new Set<string>()

/**
 * A machine was added, renamed or turned away, or its runner connected or went
 * away. When that last happens, its chats' viewers get a fresh snapshot:
 * running, read-only, or back again. So they do whenever a runner says hello,
 * even replacing a connection the hub hadn't seen drop: what the runner did
 * in between never reached them.
 */
function machineChanged(id: string, hello: boolean): void {
  machinesChanged()
  sessionsChanged()
  const online = !!machines.get(id)
  if (online === wasOnline.has(id) && !hello) return
  if (online) wasOnline.add(id)
  else wasOnline.delete(id)
  attention.update()
  broadcastTerminals()
  for (const [sessionId, set] of viewers) {
    if (machines.machineOf(sessionId) !== id) continue
    for (const ws of set) void sendSnapshot(ws, sessionId)
  }
  if (!online) return
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

/**
 * What runners can ask of the hub: the board for Claude's tools, starting
 * children, and taking their transcripts. A runner acts only for chats on its
 * own machine, and anything it says about another chat is refused, including
 * who made a change. The board is everyone's, though: its Claude can change
 * any card, and archive any chat, as Claude can from any chat.
 */
function hubApi(machine: string): Omit<HubApi, 'hello'> {
  const own = (sessionId: string): string => {
    if (!machines.owns(machine, sessionId)) throw new BadRequest(`Chat ${sessionId} isn't on this machine`)
    return sessionId
  }
  return {
    runOp: async (chat, script, input) => {
      own(chat)
      const o = hubOps.find((o) => o.script === script)
      if (!o) throw new BadRequest(`No badger.${script}`)
      if (hubOnly.has(script) && machine !== LOCAL) throw new BadRequest(`${script} only works for chats on the hub's own machine`)
      const parsed = z.object(o.input).safeParse(input ?? {})
      if (!parsed.success) throw new BadRequest(`Bad input for ${script}: ${z.prettifyError(parsed.error)}`)
      try {
        // Claude in one of this machine's chats is who makes the change; runners never act for the UI.
        return await o.run(parsed.data, { sessionId: chat, cwd: () => machines.live(chat)?.cwd ?? '' })
      } catch (err) {
        if (err instanceof OpError) throw new BadRequest(err.message)
        console.error(`badger.${script} failed for ${chat}:`, err)
        throw err
      }
    },
    chatCard: async (chat) => {
      const card = store.cards().find((c) => c.sessionIds.includes(own(chat)))
      if (!card) return undefined
      const archived = store.archivedIds()
      const chats = await chatInfo(card.sessionIds)
      return { ...card, chats: chats.map(({ id, cwd, machine }) => ({ id, cwd, machine, archived: archived.has(id) })) }
    },
    // A fork that moved is told so first, then about its card.
    cardContext: (chat) => [store.forkNote(own(chat)), cardContext(store, chat)].filter(Boolean).join('\n\n') || undefined,
    contextSeen: (chat, text) => {
      const { move, rest } = splitMoveNote(text)
      if (move) store.forkNoteSeen(own(chat))
      if (rest) contextSeen(store, own(chat), rest)
    },
    openPreview: (chat, { root, port, name, path }) => {
      own(chat)
      broadcast({ type: 'open_preview', root, machine, port, name, path })
      // The hub proxies its own machine's ports; another machine's only open where they are.
      const template = machine === LOCAL ? previewUrl() : 'http://localhost:{port}'
      return { tabs: sockets.size, url: template?.replace('{port}', String(port)).concat(path) }
    },
    startChild: ({ parentId, toolUseId, kind }) => {
      own(parentId)
      // Children run on their parent's machine. Recorded before the chat exists, so the sidebar never lists it.
      const sessionId = randomUUID()
      store.transaction(() => {
        machines.assign(sessionId, machine)
        store.addChild({ sessionId, parentId, toolUseId, kind })
      })
      return sessionId
    },
    // Not refused: a chat removed from this machine since it asked mustn't sink the rest of the batch.
    transcriptState: (files) => transcripts.state(files.filter((f) => machines.owns(machine, f.sessionId))),
    transcriptLines: (batch) => (own(batch.sessionId), takeLines(batch)),
  }
}

async function chatInfo(ids: string[]): Promise<ChatInfo[]> {
  const where = machines.machinesOf(ids)
  return Promise.all(
    [...new Set(ids)].map(async (id) => {
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

/** A runner's transcript lines, already checked to be for one of its own chats. */
function takeLines(batch: TranscriptLines) {
  // Chats sort by this, so one from the future would sit at the top of the sidebar for good.
  batch.mtime = Math.min(batch.mtime, Date.now())
  const result = store.transaction(() => transcripts.append(batch))
  if (result.bytes === batch.bytes && (batch.lines.length || batch.reset)) transcriptChanged(batch.sessionId, !!batch.more, !batch.subpath && batch.fromLine === 0)
  return result
}

const listChanged = debounced(sessionsChanged, 1000)
const liveListChanged = debounced(sessionsChanged, LIVE_LIST_MS)
const stale = new Set<string>()
const resendStale = debounced(() => {
  for (const id of stale) for (const ws of viewers.get(id) ?? []) void sendSnapshot(ws, id)
  stale.clear()
}, 500)

/**
 * A chat's transcript grew on the hub. The list may have a new title or time.
 * Viewers of a chat with no live process are watching history arrive, e.g.
 * after its machine reconnects, so they get it again; a live chat's viewers
 * already have it from the process.
 */
function transcriptChanged(sessionId: string, more: boolean, fresh: boolean): void {
  // Its first lines give a new chat its title, though.
  if (machines.live(sessionId)) return fresh ? listChanged() : liveListChanged()
  listChanged()
  // Mid-way through a long transcript: they get it all once the rest is here.
  if (more || !viewers.get(sessionId)?.size) return
  stale.add(sessionId)
  resendStale()
}

// ── Terminals: which sockets are watching which terminal ──

/**
 * Per terminal, the sockets viewing it and how many views each has open. A
 * socket isn't live until its snapshot goes out: output before then is
 * already in the snapshot.
 */
const termViewers = new Map<string, Map<WebSocket, { views: number; live: boolean }>>()

const broadcastTerminals = debounced(() => {
  if (!machines.terminalsKnown()) return
  const list = machines.terminals()
  broadcast({ type: 'terminals', terminals: list })
  // An offline machine's terminals aren't listed but haven't closed: their viewers pick up again when it's back.
  for (const id of termViewers.keys()) if (machines.terminal(id) && !list.some((t) => t.id === id)) termViewers.delete(id)
})

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
  t.machine.peer.request('termSnapshot', [t.id], (err, data) => done(err ? undefined : data), QUICK_TIMEOUT_MS)
}

function unsubscribeTerminal(ws: WebSocket, id: string): void {
  const v = termViewers.get(id)?.get(ws)
  if (v && --v.views <= 0) termViewers.get(id)!.delete(ws)
}

// ── Chats ──

/** Per viewer and chat, the number of the last snapshot asked for. */
const snapshotsAsked = new WeakMap<WebSocket, Map<string, number>>()

/**
 * Sends a viewer the chat's history and, if it's live, its process's state.
 * The history comes from the hub's copy of the transcript; the process adds
 * its own turns, which may be newer. The live part is taken last and sent the
 * moment it arrives, so the chat's events after it reach the viewer after it.
 * Only the newest snapshot asked for is sent: an older one can finish later,
 * e.g. failing on a connection its runner has just replaced.
 */
async function sendSnapshot(ws: WebSocket, sessionId: string): Promise<void> {
  let asked = snapshotsAsked.get(ws)
  if (!asked) snapshotsAsked.set(ws, (asked = new Map()))
  const n = (asked.get(sessionId) ?? 0) + 1
  asked.set(sessionId, n)
  const { text: draft, attachments: draftAttachments } = store.draft(sessionId)
  const children = store.children(sessionId)
  const machine = machines.machineOf(sessionId)
  const [history, info] = machine ? await Promise.all([transcripts.transcript(sessionId), transcripts.info(sessionId)]) : [[], undefined]
  const runner = machine ? machines.get(machine) : undefined
  const base = { type: 'snapshot' as const, sessionId, machine, draft, draftAttachments, children }
  const done = (live: LiveSnapshot | null, gone: boolean) => {
    if (asked.get(sessionId) !== n) return
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
        checking: [],
        background: [],
        queued: [],
      })
    }
    // History holds earlier processes' turns; the live list holds this process's, in order.
    const seen = new Set(live.messages.map((m) => m.uuid))
    const messages = [...history.filter((m) => !seen.has(m.uuid) && !seen.has(m.after_uuid as string)), ...live.messages]
    // The runner's answer goes first, so it can't say which chat this is.
    send(ws, { ...live, ...base, messages })
  }
  if (!runner) return done(null, false)
  const gone = info?.cwd ? (await runner.peer.within(QUICK_TIMEOUT_MS).inaccessible([info.cwd]).catch(() => [])).length > 0 : false
  // A runner slow to answer doesn't hold up the history; its answer, when it comes, puts the live part right.
  let shown = false
  const slow = setTimeout(() => ((shown = true), done(null, gone)), QUICK_TIMEOUT_MS)
  runner.peer.request('liveSnapshot', [sessionId], (err, live) => {
    clearTimeout(slow)
    if (!err) done(live, gone)
    else if (!shown) done(null, gone)
  })
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
      if (!isUuid(event.sessionId)) throw new BadRequest('sessionId must be a UUID')
      // A chat stays where it started; a new one goes where it was asked to.
      const placed = machines.machineOf(event.sessionId)
      const machine = placed ?? (event.machine || LOCAL)
      const runner = machines.require(machine)
      // Picking an archived chat back up brings it back to the sidebar.
      store.setArchived(event.sessionId, false, UI)
      attention.mark(event.sessionId, false)
      // Sending empties the composer in every tab, not just the one that sent.
      saveDraft(ws, event.sessionId, { text: '', attachments: { pastes: [], images: [] } })
      machines.assign(event.sessionId, machine)
      // A chat that's run before resumes where it was, except a fork going into a new worktree.
      const fork = placed ? store.forkStart(event.sessionId) : undefined
      const where = placed ? { cwd: fork?.cwd, worktree: fork?.worktree } : { cwd: event.cwd, worktree: event.worktree }
      try {
        await runner.peer.remote.send(event.sessionId, { ...where, mode: event.mode, model: event.model }, event.text, pastes, images)
        if (fork) store.forkStarted(event.sessionId)
      } catch (err) {
        // Turned away, so it never started: it can go elsewhere. Anything else, e.g. the connection dropping, it may have.
        if (!placed && err instanceof BadRequest) machines.unassign(event.sessionId, machine)
        // The message goes back in the composer, unless something's been typed since.
        if (!store.draft(event.sessionId).text) {
          const change = { text: event.text, attachments: { pastes, images } }
          store.setDraft(event.sessionId, change)
          for (const other of viewers.get(event.sessionId) ?? []) send(other, { type: 'draft', sessionId: event.sessionId, ...change })
        }
        throw err
      }
      return
    }
    case 'draft':
      if (event.text !== undefined && typeof event.text !== 'string') throw new BadRequest('text must be a string')
      saveDraft(ws, event.sessionId, { text: event.text, attachments: event.attachments && checkAttachments(event.attachments) })
      return
    case 'unqueue': {
      if (typeof event.id !== 'string') throw new BadRequest('id must be a string')
      const message = await runnerFor(event.sessionId)?.peer.remote.unqueue(event.sessionId, event.id)
      if (!message || !event.edit) return
      // Back into the composer, ahead of anything typed since, in every tab.
      const saved = store.draft(event.sessionId)
      const change = {
        text: [message.text, saved.text].filter(Boolean).join('\n\n'),
        attachments: { pastes: [...message.pastes, ...saved.attachments.pastes], images: [...message.images, ...saved.attachments.images] },
      }
      store.setDraft(event.sessionId, change)
      for (const other of viewers.get(event.sessionId) ?? []) send(other, { type: 'draft', sessionId: event.sessionId, ...change })
      return
    }
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
    case 'plan_draft': {
      if (typeof event.plan !== 'string') throw new BadRequest('plan must be a string')
      if (!(await runnerFor(event.sessionId)?.peer.remote.draftPlan(event.sessionId, event.requestId, event.plan))) return
      const update: ServerEvent = { type: 'plan_draft', sessionId: event.sessionId, requestId: event.requestId, plan: event.plan }
      for (const other of viewers.get(event.sessionId) ?? []) if (other !== ws) send(other, update)
      return
    }
    case 'client_error': {
      const text = (v: unknown) => (typeof v === 'string' ? v.slice(0, 4000) : '')
      console.error(`[browser] ${text(event.message)} at ${text(event.url)}${event.stack ? `\n${text(event.stack)}` : ''}`)
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
    case 'preview_url':
      if (/^https?:\/\/\{port\}\.[a-z0-9.-]+(:\d+)?$/i.test(event.url)) previewUrls.delete(ws), previewUrls.set(ws, event.url)
      return
  }
}

// ── HTTP ──

async function sessionList(): Promise<SessionSummary[]> {
  // Children show inside the chat that started them.
  const childIds = store.childIds()
  const listed = await transcripts.list(200, childIds)
  const archived = store.archivedIds()
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

/** Per runner connection, which folders it said were gone, and when. */
const goneAnswers = new WeakMap<Connection, Map<string, { gone: boolean; at: number }>>()

/**
 * Which of these folders are gone, by machine, asking each connected machine
 * once about those it hasn't answered for lately. Offline machines' folders
 * can't be checked, so they aren't.
 */
async function goneFolders(folders: { machine?: string; cwd: string }[]): Promise<Map<string, Set<string>>> {
  const byMachine = new Map<string, Set<string>>()
  for (const f of folders) if (f.machine) byMachine.set(f.machine, (byMachine.get(f.machine) ?? new Set()).add(f.cwd))
  const out = new Map<string, Set<string>>()
  const now = Date.now()
  await Promise.all(
    [...byMachine].map(async ([machine, dirs]) => {
      const runner = machines.get(machine)
      if (!runner) return
      let answers = goneAnswers.get(runner)
      if (!answers) goneAnswers.set(runner, (answers = new Map()))
      for (const [dir, a] of answers) if (now - a.at > GONE_TTL_MS) answers.delete(dir)
      const ask = [...dirs].filter((d) => !answers.has(d))
      if (ask.length) {
        const gone = await runner.peer.within(GONE_TIMEOUT_MS).inaccessible(ask).catch(() => undefined)
        // No answer isn't an answer: asked again next time.
        if (gone) for (const d of ask) answers.set(d, { gone: gone.includes(d), at: now })
      }
      out.set(machine, new Set([...dirs].filter((d) => answers.get(d)?.gone)))
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
  const m = path.match(/^\/api\/sessions\/([0-9a-f-]{36})\/(archive|title|title\/suggest|fork)$/)
  if (!m) return undefined
  const [, id, action] = m
  if (action === 'fork' && method === 'POST') return [201, await forkChat(id, await readJson(req))]
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

/**
 * Copies a chat as a new one, up to the end of the turn `at` (or all of it),
 * on the same card. It can go to another folder or runner, or into a new
 * worktree made when it first runs; then Claude is told it moved, with its
 * first message. Files stay where they are. The copy is made here, so the
 * chat's own machine needn't be online, and written on the one it goes to.
 */
async function forkChat(id: string, body: { at?: unknown; machine?: unknown; cwd?: unknown; worktree?: unknown }) {
  if (body.at !== undefined && typeof body.at !== 'string') throw new BadRequest('at must be a message id')
  if (body.worktree !== undefined && typeof body.worktree !== 'string') throw new BadRequest('worktree must be a string')
  const info = await transcripts.info(id)
  const fromMachine = machines.machineOf(id)
  const fromCwd = machines.live(id)?.cwd ?? info?.cwd
  if (!info || !fromMachine || !fromCwd) throw new BadRequest("This chat hasn't been saved yet, so it can't be forked")
  const runner = machineParam(body.machine ?? fromMachine)
  const cwd = body.cwd === undefined ? fromCwd : requirePath(body.cwd)
  const worktree = body.worktree
  const moved = runner.id !== fromMachine || cwd !== fromCwd || worktree !== undefined
  const title = `${(info.customTitle || info.summary || info.firstPrompt || 'Untitled').replace(/ \(fork\)$/, '')} (fork)`
  const fork = await forkTranscript(transcripts.store, transcripts.subagentFiles(id), id, { at: body.at, title, cwd: moved ? cwd : undefined }).catch((err) => {
    // The turn's last messages may not have been copied here yet.
    throw new BadRequest(`Couldn't fork it: ${err instanceof Error ? err.message : err}`)
  })
  const note = moved
    ? renderMoveNote({ from: { machine: machines.name(fromMachine), cwd: fromCwd }, to: { machine: runner.name, cwd, worktree: worktree !== undefined || undefined } })
    : undefined
  const card = store.cards().find((c) => c.sessionIds.includes(id))
  store.transaction(() => {
    machines.assign(fork.sessionId, runner.id)
    store.addFork({ sessionId: fork.sessionId, sourceId: id, cwd, worktree, note })
  })
  try {
    for (const file of fork.files) await runner.peer.remote.importTranscript(fork.sessionId, cwd, file)
  } catch (err) {
    store.transaction(() => {
      machines.unassign(fork.sessionId, runner.id)
      store.removeFork(fork.sessionId)
    })
    throw err
  }
  if (card) {
    store.linkSession(card.id, fork.sessionId, UI)
    cardsChanged()
  }
  sessionsChanged()
  return { sessionId: fork.sessionId }
}

/** Runner routes: the list, adding one (its token is shown once), renaming, a new token, and removing one. */
async function machinesApi(method: string, path: string, req: IncomingMessage): Promise<[number, unknown] | undefined> {
  if (path === '/api/machines') {
    if (method === 'GET') return [200, machines.list()]
    if (method === 'POST') return [201, machines.create()]
  }
  const token = path.match(/^\/api\/machines\/([a-z0-9-]+)\/token$/)
  if (token && method === 'POST') return [200, machines.resetToken(token[1])]
  const m = path.match(/^\/api\/machines\/([a-z0-9-]+)$/)
  if (m && method === 'PATCH') return [200, machines.rename(m[1], (await readJson(req)).name)]
  if (m && method === 'DELETE') return machines.remove(m[1]) ? [204, null] : [404, { error: 'No such runner' }]
  return undefined
}

/** The connected runner for a machine named in a request, defaulting to the hub's own. */
function machineParam(value: unknown): Connection {
  if (value !== undefined && value !== null && typeof value !== 'string') throw new BadRequest('machine must be a string')
  return machines.require(value || LOCAL)
}

const requirePath = (dir: unknown) => {
  if (typeof dir !== 'string' || !isAbsolute(dir)) throw new BadRequest('path must be an absolute path')
  return resolve(dir)
}

/** Worktree routes, by machine and path. Making them is Claude Code's job (--worktree); these look and clean up. */
async function worktreesApi(method: string, path: string, url: URL): Promise<[number, unknown] | undefined> {
  if (path !== '/api/worktree') return undefined
  const dir = requirePath(url.searchParams.get('path'))
  const runner = machineParam(url.searchParams.get('machine'))
  if (method === 'GET') return [200, await runner.peer.remote.worktreeStatus(dir)]
  if (method === 'DELETE') {
    await runner.peer.remote.removeWorktree(dir)
    sessionsChanged()
    return [204, null]
  }
  return undefined
}

/** Temp dirs, e.g. from tests, aren't worth offering as folders. */
const TEMP_DIR = /^\/(private\/)?(tmp|var\/folders)\//

/** The folders new chats can start in on a machine, and the file browser that adds them. */
async function foldersApi(method: string, path: string, url: URL, req: IncomingMessage): Promise<[number, unknown] | undefined> {
  if (path === '/api/folders') {
    if (method === 'GET') {
      const runner = machineParam(url.searchParams.get('machine'))
      const used = new Map<string, number>()
      for (const s of await sessionList()) {
        if ((s.machine ?? LOCAL) !== runner.id || !s.cwd || s.gone || TEMP_DIR.test(s.cwd)) continue
        used.set(s.cwd, Math.max(s.lastModified, used.get(s.cwd) ?? 0))
      }
      const { added, hidden } = store.folders(runner.id)
      return [200, await runner.peer.remote.listFolders([...used], [...added], [...hidden])]
    }
    if (method === 'POST') {
      const body = await readJson(req)
      const runner = machineParam(body.machine)
      const dir = requirePath(body.path)
      if ((await runner.peer.remote.inaccessible([dir])).length) throw new BadRequest(`${dir} isn't a folder Badger can open`)
      store.addFolder(runner.id, dir)
      return [204, null]
    }
    if (method === 'DELETE') {
      // Hiding needs no runner, so it works while the machine is offline.
      const machine = url.searchParams.get('machine') || LOCAL
      store.hideFolder(machine, requirePath(url.searchParams.get('path')))
      return [204, null]
    }
  }
  if (path === '/api/folders/size' && method === 'GET') {
    const runner = machineParam(url.searchParams.get('machine'))
    return [200, { bytes: await runner.peer.remote.folderSize(requirePath(url.searchParams.get('path'))) }]
  }
  if (path === '/api/fs' && method === 'GET') {
    const runner = machineParam(url.searchParams.get('machine'))
    const dir = url.searchParams.get('path')
    return [200, await runner.peer.remote.listDir(dir ? requirePath(dir) : undefined, url.searchParams.get('hidden') === '1')]
  }
  if (path === '/api/fs/folder' && method === 'POST') {
    const body = await readJson(req)
    return [201, { path: await machineParam(body.machine).peer.remote.makeDir(requirePath(body.path)) }]
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
  if (method === 'PATCH' && !action) {
    const { name } = await readJson(req)
    if (name !== undefined && typeof name !== 'string') throw new BadRequest('name must be a string')
    return [200, machines.upsertTerminal(t.machine, await t.machine.peer.remote.termRename(t.id, name || undefined))]
  }
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

const PREVIEW_HOSTS = { ownPort: PORT, localOnly: CHECK_HOST }

const server = createServer(async (req, res) => {
  const preview = previewPort(req.headers.host, PREVIEW_HOSTS)
  if (preview) return proxyPreview(req, res, preview)
  const url = new URL(req.url ?? '/', 'http://x')
  const json = (status: number, body: unknown) => {
    if (status === 204) return void res.writeHead(204).end()
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  if (!sameOrigin(req)) return json(403, { error: 'Cross-origin requests are not allowed' })
  try {
    if (url.pathname === '/api/config') return json(200, { defaultCwd: WORKSPACE_DIR, scratchCwd: SCRATCH_DIR, port: PORT })
    if (url.pathname.startsWith('/api/')) {
      const method = req.method ?? 'GET'
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
      if (url.pathname === '/api/git' && method === 'GET') {
        const dir = requirePath(url.searchParams.get('path'))
        const runner = machineParam(url.searchParams.get('machine'))
        return json(200, (await runner.peer.remote.gitStatus(dir, url.searchParams.get('fetch') === '1')) ?? null)
      }
      if ((url.pathname === '/api/git/push' || url.pathname === '/api/git/pull') && method === 'POST') {
        const body = await readJson(req)
        const runner = machineParam(body.machine)
        const dir = requirePath(body.path)
        await (url.pathname === '/api/git/push' ? runner.peer.remote.gitPush(dir) : runner.peer.remote.gitPull(dir))
        return json(204, null)
      }
      // A file from the file browser, e.g. an image to attach.
      if (url.pathname === '/api/fs/file' && method === 'GET') {
        const file = await machineParam(url.searchParams.get('machine')).peer.remote.readFile(requirePath(url.searchParams.get('path')))
        // Only images keep their type: anything else, like an HTML file from a repo, must never render as Badger's own page.
        res.writeHead(200, { 'content-type': file.type ?? 'application/octet-stream', 'x-content-type-options': 'nosniff', 'content-disposition': 'attachment' })
        return void res.end(Buffer.from(file.data, 'base64'))
      }
      const result =
        (await sessionsApi(method, url.pathname, req)) ??
        (await machinesApi(method, url.pathname, req)) ??
        (await worktreesApi(method, url.pathname, url)) ??
        (await terminalsApi(method, url.pathname, req)) ??
        (await cardsApi(method, url.pathname, req)) ??
        (await foldersApi(method, url.pathname, url, req))
      return result ? json(...result) : json(404, { error: 'Not found' })
    }
    // Production: serve the built client, falling back to index.html for client routes.
    let file = join(DIST, url.pathname)
    if (!file.startsWith(DIST) || !existsSync(file) || statSync(file).isDirectory()) file = join(DIST, 'index.html')
    if (!existsSync(file)) return json(404, { error: 'Client not built; run `pnpm build` or use `pnpm dev`' })
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' })
    createReadStream(file).pipe(res)
  } catch (err) {
    // Failed partway through a response: too late to say why.
    if (res.headersSent) return void res.destroy()
    if (err instanceof BadRequest) return json(400, { error: err.message })
    json(500, { error: err instanceof Error ? err.message : String(err) })
  }
})

const wss = new WebSocketServer({ noServer: true })
// Transcript lines can be big (pasted images); runners send bigger ones as blanks (see sync.ts).
const runnerWss = new WebSocketServer({ noServer: true, maxPayload: RUNNER_MAX_FRAME })

server.on('upgrade', (req, socket, head) => {
  const preview = previewPort(req.headers.host, PREVIEW_HOSTS)
  if (preview) {
    if (req.url === `${BRIDGE_PATH}bridge`) return bridges.upgrade(req, socket, head, preview)
    return proxyPreviewUpgrade(req, socket, head, preview)
  }
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
      const why = mismatch(req.headers[PROTOCOL_HEADER])
      machines.refused(machine, why)
      return refuse('426 Upgrade Required', why)
    }
    return runnerWss.handleUpgrade(req, socket, head, (ws) => connectRunner(machine, token, ws))
  }
  if (url.pathname !== '/ws') return refuse('404 Not Found')
  if (!sameOrigin(req)) return refuse('403 Forbidden')
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws))
})

/** A remote runner's connection, dropped if it stops answering pings (a laptop that went to sleep mid-connection). */
function connectRunner(machine: string, token: string, ws: WebSocket): void {
  let alive = true
  ws.on('pong', () => (alive = true))
  const ping = setInterval(() => {
    if (!alive) return ws.terminate()
    alive = false
    ws.ping()
  }, RUNNER_PING_MS)
  ws.on('close', () => clearInterval(ping))
  machines.attach(machine, wsLink(ws), hubApi, token)
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
  // Each chat's events are handled in order, so a snapshot can't overtake a later status. Chats don't wait on
  // each other: one whose machine has stopped answering doesn't hold up the rest of the tab.
  const chains = new Map<string, Promise<void>>()
  ws.on('message', (raw) => {
    let event: ClientEvent
    try {
      event = JSON.parse(String(raw))
    } catch {
      return
    }
    const key = 'sessionId' in event && typeof event.sessionId === 'string' ? event.sessionId : ''
    const next = (chains.get(key) ?? Promise.resolve()).then(() =>
      handleClient(ws, event).catch((err) =>
        send(ws, {
          type: 'error',
          sessionId: 'sessionId' in event ? event.sessionId : undefined,
          error: err instanceof Error ? err.message : String(err),
        }),
      ),
    )
    chains.set(key, next)
    void next.then(() => chains.get(key) === next && chains.delete(key))
  })
  ws.on('close', () => {
    sockets.delete(ws)
    previewUrls.delete(ws)
    for (const set of viewers.values()) set.delete(ws)
    for (const set of termViewers.values()) set.delete(ws)
  })
})

// The hub's own machine: a runner in this process, over an in-memory link.
const runner = new Runner({ workspaceDir: WORKSPACE_DIR, scratchDir: SCRATCH_DIR, dataDir: DATA_DIR, env: startEnv })
const [hubEnd, runnerEnd] = memoryLinks()
importOlderChats()
machines.attach(LOCAL, hubEnd, hubApi)
runner.connect(runnerEnd).catch((err) => console.error('The hub’s own runner failed to start:', err))

server.listen(PORT, HOST, () => {
  console.log(`badger server on http://${HOST}:${PORT} (workspace ${WORKSPACE_DIR})`)
})

// A promise nobody caught, e.g. from a runner's odd answer, is a bug to fix, not a reason to drop every chat.
process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err))

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    runner.closeAll()
    process.exit(0)
  })
}

/**
 * Once, on the first start with machines: puts every chat Claude Code has on this machine on the hub's machine, since
 * Badger didn't use to record which were its. Done before the hub's runner connects, so its first chat list has them.
 * After this, only chats started in Badger are added.
 */
function importOlderChats(): void {
  if (!store.db.prepare('SELECT 1 FROM pending_import').get()) return
  const projects = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects')
  const insert = store.db.prepare('INSERT OR IGNORE INTO chat_machines (session_id, machine, created_at) VALUES (?, ?, ?)')
  store.transaction(() => {
    for (const project of readdirSafe(projects)) {
      for (const name of readdirSafe(join(projects, project))) {
        const sessionId = name.slice(0, -'.jsonl'.length)
        if (!name.endsWith('.jsonl') || !isUuid(sessionId)) continue
        const info = statSync(join(projects, project, name), { throwIfNoEntry: false })
        if (info?.isFile()) insert.run(sessionId, LOCAL, Math.floor(info.mtimeMs))
      }
    }
    store.db.exec('DELETE FROM pending_import')
  })
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

function loadDotEnv(): void {
  if (!existsSync('.env')) return
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m && m[2] && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
}
