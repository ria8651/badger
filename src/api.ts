import { createSignal } from 'solid-js'
import type { Card, CardStatus, ClientEvent, ModelOption, ServerEvent, SessionSummary, TerminalInfo, WorktreeStatus } from '../shared/protocol.ts'

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

type Config = { defaultCwd: string; scratchCwd: string; port: number }

type CardPatch = Partial<Pick<Card, 'title' | 'description' | 'status' | 'position' | 'parentId'>>

export const api = {
  config: () => get<Config>('/api/config'),
  sessions: () => get<SessionSummary[]>('/api/sessions'),
  models: () => get<ModelOption[]>('/api/models'),
  archive: (sessionId: string) => request<void>('POST', `/api/sessions/${sessionId}/archive`),
  unarchive: (sessionId: string) => request<void>('DELETE', `/api/sessions/${sessionId}/archive`),
  rename: (sessionId: string, title: string) => request<void>('PUT', `/api/sessions/${sessionId}/title`, { title }),
  suggestTitle: (sessionId: string) => request<{ title: string }>('POST', `/api/sessions/${sessionId}/title/suggest`),
  cards: () => get<Card[]>('/api/cards'),
  createCard: (card: { title: string; description?: string; status?: CardStatus; parentId?: number | null }) => request<Card>('POST', '/api/cards', card),
  updateCard: (id: number, patch: CardPatch) => request<Card>('PATCH', `/api/cards/${id}`, patch),
  deleteCard: (id: number) => request<void>('DELETE', `/api/cards/${id}`),
  linkSession: (id: number, sessionId: string) => request<Card>('POST', `/api/cards/${id}/sessions`, { sessionId }),
  unlinkSession: (id: number, sessionId: string) => request<Card>('DELETE', `/api/cards/${id}/sessions/${sessionId}`),
  worktree: (path: string) => get<WorktreeStatus>(`/api/worktree?path=${encodeURIComponent(path)}`),
  removeWorktree: (path: string) => request<void>('DELETE', `/api/worktree?path=${encodeURIComponent(path)}`),
  workspace: (cwd: string) => get<{ root: string }>(`/api/workspace?cwd=${encodeURIComponent(cwd)}`),
  createTerminal: (spec: { cwd: string; command?: string; cols?: number; rows?: number }) =>
    request<TerminalInfo>('POST', '/api/terminals', spec),
  restartTerminal: (id: string) => request<TerminalInfo>('POST', `/api/terminals/${id}/restart`),
  closeTerminal: (id: string) => request<void>('DELETE', `/api/terminals/${id}`),
}

type Listener = (event: ServerEvent) => void

/**
 * One shared WebSocket with automatic reconnect. Subscriptions are remembered
 * and replayed on reconnect so views resync from a fresh snapshot.
 */
class Socket {
  private ws: WebSocket | null = null
  private listeners = new Set<Listener>()
  private subscriptions = new Set<string>()
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
      for (const id of this.subscriptions) this.raw({ type: 'subscribe', sessionId: id })
      for (const [id, views] of this.terminals) for (let i = 0; i < views; i++) this.raw({ type: 'term_subscribe', id })
    }
    ws.onmessage = (e) => {
      const event = JSON.parse(e.data) as ServerEvent
      for (const l of this.listeners) l(event)
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
    if (event.type === 'subscribe') this.subscriptions.add(event.sessionId)
    if (event.type === 'unsubscribe') this.subscriptions.delete(event.sessionId)
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
