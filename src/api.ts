import type { ClientEvent, ServerEvent, SessionSummary } from '../shared/protocol.ts'

const TOKEN_KEY = 'badger.token'

export function getToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? ''
  } catch {
    return ''
  }
}

export function setToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token)
  } catch {
    /* private mode */
  }
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { authorization: `Bearer ${getToken()}` } })
  if (!res.ok) throw Object.assign(new Error(`${res.status} ${res.statusText}`), { status: res.status })
  return res.json()
}

export const api = {
  config: () => get<{ defaultCwd: string; authRequired: boolean }>('/api/config'),
  sessions: () => get<SessionSummary[]>('/api/sessions'),
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
  private outbox: ClientEvent[] = []
  private retry = 0
  connected = false
  private connListeners = new Set<(c: boolean) => void>()

  connect(): void {
    if (this.ws) return
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(getToken())}`)
    this.ws = ws
    ws.onopen = () => {
      this.retry = 0
      this.setConnected(true)
      for (const id of this.subscriptions) this.raw({ type: 'subscribe', sessionId: id })
      for (const e of this.outbox.splice(0)) this.raw(e)
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
    if (this.ws?.readyState === WebSocket.OPEN) this.raw(event)
    else if (event.type !== 'subscribe' && event.type !== 'unsubscribe') this.outbox.push(event)
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
