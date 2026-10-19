import { createSignal } from 'solid-js'
import { createStore, produce, reconcile } from 'solid-js/store'
import type { SessionSummary } from '../../shared/protocol.ts'
import { api, socket } from '../api.ts'
import { LOCAL } from '../machines.ts'
import { knowRoots } from '../terminals.ts'
import { configReady } from './config.ts'

/**
 * Every chat as the sidebar lists it, kept current over the socket. Reconciled by id, so a refresh updates
 * rows in place rather than rebuilding them, and changes made here show at once and are undone if the server
 * says no.
 */
const [list, setList] = createStore<SessionSummary[]>([])
export const sessions = () => list
/** False until the list has arrived, so a chat that isn't in it yet isn't taken for not existing. */
const [loaded, setLoaded] = createSignal(false)
export const sessionsLoaded = loaded

export const sessionById = (id: string) => list.find((s) => s.id === id)

const refresh = () =>
  api.sessions().then((next) => {
    // Their workspaces too, so a chat opens beside its panels on the first frame.
    knowRoots(next.flatMap((s) => (s.cwd && s.root ? [{ machine: s.machine ?? LOCAL, cwd: s.cwd, root: s.root }] : [])))
    setList(reconcile(next, { key: 'id' }))
    setLoaded(true)
  })

let timer: ReturnType<typeof setTimeout> | undefined
/** Several changes in a row, like a turn's messages arriving, make one fetch. */
const refreshSoon = () => {
  clearTimeout(timer)
  timer = setTimeout(() => void refresh().catch(() => {}), 300)
}

// Every connect loads, the first included, after the config, which the folder defaults need. The list may have
// changed while the server was away.
socket.onConnection((connected) => connected && void configReady.then(refresh).catch(() => {}))
socket.on((e) => {
  if (e.type === 'sessions_changed') refreshSoon()
  // Whether a chat is working shows at once. Anything else that changes with it, like its time, comes with the
  // sessions_changed the server sends too; a chat not listed yet needs the list.
  if (e.type === 'status') {
    if (sessionById(e.sessionId)) patch(e.sessionId, e.cwd ? { running: e.running, cwd: e.cwd } : { running: e.running })
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
  return change(s.id, { archived }, () => (archived ? api.archive(s.id) : api.unarchive(s.id)))
}

export const renameSession = (id: string, title: string) => change(id, { title }, () => api.rename(id, title))
