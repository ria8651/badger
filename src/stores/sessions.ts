import { createSignal } from 'solid-js'
import { createStore, produce, reconcile, unwrap } from 'solid-js/store'
import type { SessionSummary } from '../../shared/protocol.ts'
import { api, socket } from '../api.ts'
import { LOCAL } from '../machines.ts'
import { knowRoots } from '../terminals.ts'
import { configReady } from './config.ts'

/**
 * The chats the app knows of, kept current over the socket: every one that isn't archived and every one on a card,
 * as the list has them, and archived ones fetched besides it. Reconciled by id, so a refresh updates rows in place
 * rather than rebuilding them, and changes made here show at once and are undone if the server says no.
 */
const [list, setList] = createStore<SessionSummary[]>([])
export const sessions = () => list
/** False until the list has arrived, so a chat that isn't in it yet isn't taken for not existing. */
const [loaded, setLoaded] = createSignal(false)
export const sessionsLoaded = loaded

export const sessionById = (id: string) => list.find((s) => s.id === id)

/**
 * Every chat that isn't archived, and every one on a card, come in the list, so a card shows all of its own. Other
 * archived chats are fetched as they're wanted, a page at a time for the sidebar (see archivedList.ts) or one that's
 * opened, and kept with the list from then on, so they're looked up and changed like the rest.
 */
const fetched = new Set<string>()
/** What the list last had, which wins over a chat fetched besides it. */
let inList = new Set<string>()
/** Goes up each time the list is fetched, for what's fetched besides it to be fetched again. */
const [version, setVersion] = createSignal(0)
export const listVersion = version
/** Chats looked up once already: see lookUp. */
const asked = new Set<string>()

const knowRootsOf = (list: SessionSummary[]) =>
  knowRoots(list.flatMap((s) => (s.cwd && s.root ? [{ machine: s.machine ?? LOCAL, cwd: s.cwd, root: s.root }] : [])))

const refresh = () =>
  api.sessions().then((next) => {
    // Their workspaces too, so a chat opens beside its panels on the first frame.
    knowRootsOf(next)
    const before = inList
    inList = new Set(next.map((s) => s.id))
    // One that's gone from the list, archived from somewhere else say, can be looked up again if it's open.
    for (const id of before) if (!inList.has(id)) asked.delete(id)
    const kept = unwrap(list).filter((s) => fetched.has(s.id) && !inList.has(s.id))
    setList(reconcile([...next, ...kept], { key: 'id' }))
    setLoaded(true)
    setVersion((v) => v + 1)
  })

/** Keeps chats fetched besides the list, updating ones already kept in place, so their rows stay as they are. */
export function remember(found: SessionSummary[]): void {
  knowRootsOf(found)
  for (const s of found) {
    fetched.add(s.id)
    const i = list.findIndex((x) => x.id === s.id)
    if (i < 0) setList(list.length, s)
    else if (!inList.has(s.id)) setList(i, reconcile(s))
  }
}

/**
 * Fetches a chat that's open but not in the list, e.g. an archived one, with its side chats. Once, as one that
 * doesn't exist yet is new, until it leaves the list.
 */
export function lookUp(id: string): void {
  if (!loaded() || sessionById(id) || asked.has(id)) return
  asked.add(id)
  api
    .session(id)
    .then(remember)
    .catch(() => {})
}

let timer: ReturnType<typeof setTimeout> | undefined
/** Several changes in a row, like a turn's messages arriving, make one fetch. */
const refreshSoon = () => {
  clearTimeout(timer)
  timer = setTimeout(() => void refresh().catch(() => {}), 300)
}

// Every connect loads, the first included, after the config, which the folder defaults need. The list may have
// changed while the server was away.
socket.onConnection((connected) => connected && void configReady.then(refresh).catch(() => {}))
/**
 * Child chats' parents, as their snapshots say: children aren't in the list, so this is how one on screen finds
 * the chat to be listed under.
 */
const [childParents, setChildParents] = createStore<Record<string, { id: string; toolUseId: string; title: string }>>({})

/** The chat a nested chat sits under, with how its row there reads: a side chat's, or a child chat's once it's been opened. */
export function parentOf(id: string): { parent: string; title: string; toolUseId?: string } | undefined {
  const side = sessionById(id)
  if (side?.sideOf) return { parent: side.sideOf, title: side.title }
  const child = childParents[id]
  return child && { parent: child.id, title: child.title, toolUseId: child.toolUseId }
}

socket.on((e) => {
  if (e.type === 'snapshot' && e.parent && !childParents[e.sessionId]) setChildParents(e.sessionId, e.parent)
  if (e.type === 'sessions_changed') refreshSoon()
  // Whether a chat is working shows at once. Anything else that changes with it, like its time, comes with the
  // sessions_changed the server sends too; a chat not listed yet needs the list.
  if (e.type === 'status') {
    // Its recap is out of date once it starts working, and shouldn't show again under what the turn adds.
    if (sessionById(e.sessionId)) patch(e.sessionId, { running: e.running, ...(e.cwd ? { cwd: e.cwd } : {}), ...(e.running ? { recap: undefined } : {}) })
    else refreshSoon()
  }
})

const patch = (id: string, change: Partial<SessionSummary>) =>
  setList(
    (s) => s.id === id,
    produce((s) => Object.assign(s, change)),
  )

/** Changes a chat here straight away, then on the server; if the server refuses, the list is fetched again and the error passed on. */
async function change(id: string, local: Partial<SessionSummary>, remote: () => Promise<unknown>): Promise<void> {
  patch(id, local)
  try {
    await remote()
  } catch (e) {
    void refresh().catch(() => {})
    throw e
  }
}

/** Archives a chat, or brings it back. */
export const toggleArchived = (s: SessionSummary) => {
  const archived = !s.archived
  // Kept once it's archived, though the list won't have it, for if it's on screen.
  fetched.add(s.id)
  return change(s.id, { archived }, () => (archived ? api.archive(s.id) : api.unarchive(s.id)))
}

/** Throws away what's typed in a chat. One that hasn't started is gone then. */
export async function discardDraft(id: string): Promise<void> {
  if (sessionById(id)?.unstarted) setList((l) => l.filter((s) => s.id !== id))
  else patch(id, { draft: false })
  try {
    await api.discardDraft(id)
  } catch (e) {
    void refresh().catch(() => {})
    throw e
  }
}

export const renameSession =(id: string, title: string) => change(id, { title }, () => api.rename(id, title))
