import type { WebSocket } from 'ws'
import type { ServerEvent } from '../../shared/protocol.ts'
import type { TabIdentity } from '../analytics.ts'

/**
 * The browser tabs connected to the hub, and which chats each is viewing. A
 * chat's events go to its viewers; everything else to every tab.
 */
export class Viewers {
  private tabs = new Set<WebSocket>()
  private chats = new Map<string, Set<WebSocket>>()
  /**
   * Where each tab reaches previews, with `{port}` in it. Claude gets the
   * latest that isn't localhost when there is one, since that works from
   * anywhere, and the user may be on their phone.
   */
  private previewUrls = new Map<WebSocket, string>()
  /** Who each tab said it is, and when it connected. */
  private identities = new Map<WebSocket, TabIdentity & { since: number }>()

  /** How many tabs are connected. */
  get count(): number {
    return this.tabs.size
  }

  add(ws: WebSocket): void {
    this.tabs.add(ws)
  }

  /** A tab closed: it views nothing any more. */
  drop(ws: WebSocket): void {
    this.tabs.delete(ws)
    this.previewUrls.delete(ws)
    this.identities.delete(ws)
    for (const set of this.chats.values()) set.delete(ws)
  }

  watch(ws: WebSocket, sessionId: string): void {
    let set = this.chats.get(sessionId)
    if (!set) this.chats.set(sessionId, (set = new Set()))
    set.add(ws)
  }

  unwatch(ws: WebSocket, sessionId: string): void {
    this.chats.get(sessionId)?.delete(ws)
  }

  /** A chat's viewers. */
  of(sessionId: string): WebSocket[] {
    return [...(this.chats.get(sessionId) ?? [])]
  }

  /** Every chat someone is viewing. */
  watched(): string[] {
    return [...this.chats].flatMap(([id, set]) => (set.size ? [id] : []))
  }

  send(ws: WebSocket, event: ServerEvent): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(event))
  }

  toAll(event: ServerEvent): void {
    for (const ws of this.tabs) this.send(ws, event)
  }

  /** To a chat's viewers, but `except` one: e.g. the tab that made the change, which already shows it. */
  toChat(sessionId: string, event: ServerEvent, opts: { except?: WebSocket } = {}): void {
    for (const ws of this.of(sessionId)) if (ws !== opts.except) this.send(ws, event)
  }

  /** A chat's event to its viewers; anything else to every tab. */
  publish(event: ServerEvent): void {
    if ('sessionId' in event && event.sessionId) this.toChat(event.sessionId, event)
    else this.toAll(event)
  }

  identify(ws: WebSocket, id: TabIdentity): void {
    this.identities.set(ws, { ...id, since: Date.now() })
  }

  /** Who a tab is, once it has said. */
  identity(ws: WebSocket): (TabIdentity & { since: number }) | undefined {
    return this.identities.get(ws)
  }

  setPreviewUrl(ws: WebSocket, url: string): void {
    this.previewUrls.delete(ws)
    this.previewUrls.set(ws, url)
  }

  previewUrl(): string | undefined {
    const urls = [...this.previewUrls.values()].reverse()
    return urls.find((u) => !/\{port\}\.localhost\b/.test(u)) ?? urls[0]
  }
}

/** Runs `fn` once, shortly, however many times this is called meanwhile. */
export function debounced(fn: () => void, ms: number): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  return () => {
    timer ??= setTimeout(() => {
      timer = undefined
      fn()
    }, ms)
  }
}
