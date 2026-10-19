import { createSignal } from 'solid-js'
import type { Card, CardStatus, ClientEvent, GitStatus, Folder, Listing, Machine, ModelOption, ServerEvent, SessionSummary, TerminalInfo, WorktreeStatus } from '../shared/protocol.ts'

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    const message = await res.json().then((b) => b.error, () => null)
    throw Object.assign(new Error(message ?? `${res.status} ${res.statusText}`), { status: res.status })
  }
  return res.status === 204 ? (undefined as T) : res.json()
}

const get = <T>(path: string) => request<T>('GET', path)

export type Config = { defaultCwd: string; scratchCwd: string; port: number }

type CardPatch = Partial<Pick<Card, 'title' | 'description' | 'status' | 'position' | 'parentId'>>

export const api = {
  config: () => get<Config>('/api/config'),
  sessions: () => get<SessionSummary[]>('/api/sessions'),
  models: () => get<ModelOption[]>('/api/models'),
  archive: (sessionId: string) => request<void>('POST', `/api/sessions/${sessionId}/archive`),
  unarchive: (sessionId: string) => request<void>('DELETE', `/api/sessions/${sessionId}/archive`),
  rename: (sessionId: string, title: string) => request<void>('PUT', `/api/sessions/${sessionId}/title`, { title }),
  suggestTitle: (sessionId: string) => request<{ title: string }>('POST', `/api/sessions/${sessionId}/title/suggest`),
  /** A copy of the chat up to the end of the turn `at`, here or somewhere else. Returns the new chat's id. */
  fork: (sessionId: string, to: { at?: string; machine?: string; cwd?: string; worktree?: string; draft?: string }) =>
    request<{ sessionId: string }>('POST', `/api/sessions/${sessionId}/fork`, to),
  cards: () => get<Card[]>('/api/cards'),
  createCard: (card: { title: string; description?: string; status?: CardStatus; parentId?: number | null }) => request<Card>('POST', '/api/cards', card),
  updateCard: (id: number, patch: CardPatch) => request<Card>('PATCH', `/api/cards/${id}`, patch),
  deleteCard: (id: number) => request<void>('DELETE', `/api/cards/${id}`),
  linkSession: (id: number, sessionId: string) => request<Card>('POST', `/api/cards/${id}/sessions`, { sessionId }),
  unlinkSession: (id: number, sessionId: string) => request<Card>('DELETE', `/api/cards/${id}/sessions/${sessionId}`),
  // Folders, files, git and terminals are on a machine: the hub's own unless one is given.
  worktree: (path: string, machine?: string) => get<WorktreeStatus>(`/api/worktree?${on(machine, { path })}`),
  /** Null outside a git repo. Fetching first makes "behind" current, but can take a moment. */
  git: (path: string, machine?: string, fetch = false) => get<GitStatus | null>(`/api/git?${on(machine, { path, ...(fetch ? { fetch: '1' } : {}) })}`),
  push: (path: string, machine?: string) => request<void>('POST', '/api/git/push', { path, machine }),
  pull: (path: string, machine?: string) => request<void>('POST', '/api/git/pull', { path, machine }),
  removeWorktree: (path: string, machine?: string) => request<void>('DELETE', `/api/worktree?${on(machine, { path })}`),
  folders: (machine?: string) => get<Folder[]>(`/api/folders?${on(machine)}`),
  addFolder: (path: string, machine?: string) => request<void>('POST', '/api/folders', { path, machine }),
  hideFolder: (path: string, machine?: string) => request<void>('DELETE', `/api/folders?${on(machine, { path })}`),
  folderSize: (path: string, machine?: string) => get<{ bytes: number }>(`/api/folders/size?${on(machine, { path })}`),
  listDir: (path: string | undefined, hidden: boolean, machine?: string) =>
    get<Listing>(`/api/fs?${on(machine, { ...(path ? { path } : {}), ...(hidden ? { hidden: '1' } : {}) })}`),
  makeFolder: (path: string, machine?: string) => request<{ path: string }>('POST', '/api/fs/folder', { path, machine }),
  fileUrl: (path: string, machine?: string) => `/api/fs/file?${on(machine, { path })}`,
  /** A file's contents, e.g. an image picked on the server to attach. */
  fileBlob: async (path: string, machine?: string) => {
    const res = await fetch(api.fileUrl(path, machine))
    if (!res.ok) throw new Error(res.statusText)
    return res.blob()
  },
  workspace: (cwd: string, machine?: string) => get<{ root: string }>(`/api/workspace?${on(machine, { cwd })}`),
  createTerminal: (spec: { cwd: string; machine?: string; command?: string; cols?: number; rows?: number }) =>
    request<TerminalInfo>('POST', '/api/terminals', spec),
  restartTerminal: (id: string) => request<TerminalInfo>('POST', `/api/terminals/${id}/restart`),
  /** An empty name puts the default back. */
  renameTerminal: (id: string, name: string) => request<TerminalInfo>('PATCH', `/api/terminals/${id}`, { name }),
  closeTerminal: (id: string) => request<void>('DELETE', `/api/terminals/${id}`),
  machines: () => get<Machine[]>('/api/machines'),
  /** A new runner, named after its host once it first connects. Its token is only ever shown here. */
  addMachine: () => request<{ machine: Machine; token: string }>('POST', '/api/machines'),
  /** Replaces a runner's token; the old one stops working at once. The new one is only shown here. */
  resetMachineToken: (id: string) => request<{ machine: Machine; token: string }>('POST', `/api/machines/${id}/token`),
  renameMachine: (id: string, name: string) => request<Machine>('PATCH', `/api/machines/${id}`, { name }),
  removeMachine: (id: string) => request<void>('DELETE', `/api/machines/${id}`),
}

/** Query parameters, with the machine when one is given. */
const on = (machine: string | undefined, params: Record<string, string> = {}) =>
  new URLSearchParams({ ...params, ...(machine ? { machine } : {}) }).toString()

type Listener = (event: ServerEvent) => void

/**
 * One shared WebSocket with automatic reconnect. Subscriptions are remembered
 * and replayed on reconnect so views resync from a fresh snapshot.
 */
class Socket {
  private ws: WebSocket | null = null
  private listeners = new Set<Listener>()
  /** Open views per session. Each subscribe gets a fresh snapshot; the server only hears unsubscribe once the last closes. */
  private subscriptions = new Map<string, number>()
  /** Open views per terminal; the server counts them too, and each subscribe gets a fresh snapshot. */
  private terminals = new Map<string, number>()
  private outbox: ClientEvent[] = []
  private retry = 0
  connected = false
  private connListeners = new Set<(c: boolean) => void>()

  connect(): void {
    if (this.ws) return
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${location.host}/ws`)
    this.ws = ws
    ws.onopen = () => {
      this.retry = 0
      this.setConnected(true)
      // Queued events go first so the fresh snapshots already include them, e.g. a draft typed while offline.
      for (const e of this.outbox.splice(0)) this.raw(e)
      for (const id of this.subscriptions.keys()) this.raw({ type: 'subscribe', sessionId: id })
      for (const [id, views] of this.terminals) for (let i = 0; i < views; i++) this.raw({ type: 'term_subscribe', id })
    }
    ws.onmessage = (e) => {
      const event = JSON.parse(e.data) as ServerEvent
      // One listener throwing mustn't keep the event from the rest; the error is still reported.
      for (const l of this.listeners) {
        try {
          l(event)
        } catch (err) {
          reportError(err)
        }
      }
    }
    ws.onclose = () => {
      this.setConnected(false)
      this.ws = null
      setTimeout(() => this.connect(), Math.min(10_000, 500 * 2 ** this.retry++))
    }
  }

  on(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  onConnection(listener: (connected: boolean) => void): () => void {
    this.connListeners.add(listener)
    return () => this.connListeners.delete(listener)
  }

  send(event: ClientEvent): void {
    if (event.type === 'subscribe') this.subscriptions.set(event.sessionId, (this.subscriptions.get(event.sessionId) ?? 0) + 1)
    if (event.type === 'unsubscribe') {
      const views = (this.subscriptions.get(event.sessionId) ?? 1) - 1
      if (views > 0) return void this.subscriptions.set(event.sessionId, views)
      this.subscriptions.delete(event.sessionId)
    }
    if (event.type === 'term_subscribe') this.terminals.set(event.id, (this.terminals.get(event.id) ?? 0) + 1)
    if (event.type === 'term_unsubscribe') {
      const views = (this.terminals.get(event.id) ?? 1) - 1
      if (views > 0) this.terminals.set(event.id, views)
      else this.terminals.delete(event.id)
    }
    if (this.ws?.readyState === WebSocket.OPEN) this.raw(event)
    // Subscriptions are replayed on connect; keystrokes typed into a dead connection are dropped rather than replayed later.
    else if (event.type === 'draft') {
      // Only the latest of each part matters: later text replaces earlier text, but not earlier attachments.
      const queued = this.outbox.find((e) => e.type === 'draft' && e.sessionId === event.sessionId)
      this.outbox = this.outbox.filter((e) => e !== queued)
      this.outbox.push(queued?.type === 'draft' ? { ...queued, ...event } : event)
    } else if (event.type === 'answer_draft' || event.type === 'plan_draft') {
      this.outbox = this.outbox.filter((e) => !(e.type === event.type && e.requestId === event.requestId))
      this.outbox.push(event)
    } else if (!['subscribe', 'unsubscribe', 'term_subscribe', 'term_unsubscribe', 'term_input'].includes(event.type)) this.outbox.push(event)
  }

  private raw(event: ClientEvent): void {
    this.ws?.send(JSON.stringify(event))
  }

  private setConnected(c: boolean): void {
    this.connected = c
    for (const l of this.connListeners) l(c)
  }
}

export const socket = new Socket()

const [connected, setConnected] = createSignal(false)
socket.onConnection(setConnected)
/** Whether the socket to the server is up, as a signal. */
export { connected }
