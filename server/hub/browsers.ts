import type { WebSocket } from 'ws'
import type { ClientEvent } from '../../shared/protocol.ts'
import type { Analytics } from '../analytics.ts'
import type { Attention } from '../attention.ts'
import { parseClientEvent } from '../clientProtocol.ts'
import { message } from '../errors.ts'
import type { Machines } from '../machines.ts'
import type { AccountLimits } from '../usage.ts'
import type { Chats } from './chats.ts'
import type { HubTerminals } from './terminals.ts'
import type { Viewers } from './viewers.ts'

export interface BrowserDeps {
  viewers: Viewers
  chats: Chats
  terminals: HubTerminals
  machines: Machines
  attention: Attention
  account: AccountLimits
  analytics: Analytics
}

/**
 * A browser tab's WebSocket: everything it needs to start with, then its
 * events, each checked and handed to whichever part of the hub it's for.
 */
export function serveBrowser(ws: WebSocket, d: BrowserDeps): void {
  const { viewers } = d
  viewers.add(ws)
  viewers.send(ws, { type: 'machines', machines: d.machines.list() })
  // Before every machine's PTY host has said hello the list is unknown, not empty; it's broadcast once they have.
  const terminals = d.terminals.list()
  if (terminals) viewers.send(ws, { type: 'terminals', terminals })
  const latest = d.account.latest()
  if (latest) viewers.send(ws, { type: 'account_usage', usage: latest })
  void d.account.refresh()
  viewers.send(ws, { type: 'attention', chats: d.attention.chats() })
  // Each chat's events are handled in order, so a snapshot can't overtake a later status. Chats don't wait on
  // each other: one whose machine has stopped answering doesn't hold up the rest of the tab.
  const chains = new Map<string, Promise<void>>()
  ws.on('message', (data) => {
    let raw: { sessionId?: unknown } | null
    try {
      raw = JSON.parse(String(data))
    } catch {
      return
    }
    const sessionId = typeof raw?.sessionId === 'string' ? raw.sessionId : undefined
    // Taken as they come, not after the chat's other events: they're stamped with when they arrive.
    if (INSTANT.has((raw as { type?: unknown } | null)?.type as string)) {
      try {
        const event = parseClientEvent(raw)
        if (event) void handle(ws, event, d)
      } catch {}
      return
    }
    const key = sessionId ?? ''
    const next = (chains.get(key) ?? Promise.resolve()).then(async () => {
      try {
        const event = parseClientEvent(raw)
        if (event) await handle(ws, event, d)
      } catch (err) {
        viewers.send(ws, { type: 'error', sessionId, error: message(err) })
      }
    })
    chains.set(key, next)
    void next.then(() => chains.get(key) === next && chains.delete(key))
  })
  // Errors end in a close, handled below. Unheard, one (e.g. a message over maxPayload) would crash the hub.
  ws.on('error', () => {})
  ws.on('close', () => {
    const id = viewers.identity(ws)
    if (id) {
      d.analytics.tabClosed(id)
      d.analytics.event('tab.close', { client: id.client, tab: id.tab, durationMs: Date.now() - id.since })
    }
    viewers.drop(ws)
    d.terminals.drop(ws)
  })
}

/** What a tab says about itself, for analytics. */
const INSTANT = new Set(['hello', 'activity', 'ui_event'])

async function handle(ws: WebSocket, event: ClientEvent, d: BrowserDeps): Promise<void> {
  const tab = d.viewers.identity(ws)
  const from = { actor: { source: 'ui' as const }, client: tab?.client, tab: tab?.tab }
  switch (event.type) {
    case 'hello':
      d.viewers.identify(ws, { client: event.client, tab: event.tab })
      d.analytics.hello(event)
      d.analytics.event('tab.open', { actor: from.actor, client: event.client, tab: event.tab, data: { viewport: event.info.viewport, build: event.info.build } })
      return
    case 'activity':
      if (tab) d.analytics.activity(tab, event, event.sessionId ? !!d.machines.live(event.sessionId)?.running : undefined)
      return
    case 'ui_event':
      d.analytics.event(`ui.${event.name}`, { ...from, sessionId: event.sessionId, data: event.data })
      return
    case 'subscribe':
      d.analytics.event('chat.open', { ...from, sessionId: event.sessionId })
      return d.chats.subscribe(ws, event.sessionId)
    case 'unsubscribe':
      d.analytics.event('chat.close', { ...from, sessionId: event.sessionId })
      return d.viewers.unwatch(ws, event.sessionId)
    case 'seen':
      if (d.attention.mark(event.sessionId, false)) d.analytics.event('chat.seen', { ...from, sessionId: event.sessionId })
      return
    case 'term_subscribe':
      return d.terminals.subscribe(ws, event.id)
    case 'term_unsubscribe':
      return d.terminals.unsubscribe(ws, event.id)
    case 'term_input':
      d.analytics.terminalIo(event.id, 'in', event.data.length)
      return d.terminals.input(event.id, event.data)
    case 'term_resize':
      return d.terminals.resize(event.id, event.cols, event.rows)
    case 'preview_url':
      if (/^https?:\/\/\{port\}\.[a-z0-9.-]+(:\d+)?$/i.test(event.url)) d.viewers.setPreviewUrl(ws, event.url)
      return
    case 'client_error': {
      const text = (v: string) => v.slice(0, 4000)
      console.error(`[browser] ${text(event.message)} at ${text(event.url)}${event.stack ? `\n${text(event.stack)}` : ''}`)
      d.analytics.event('client.error', { ...from, data: { message: text(event.message), url: text(event.url) } })
      return
    }
    default:
      return d.chats.handle(ws, event)
  }
}
