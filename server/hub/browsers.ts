import type { WebSocket } from 'ws'
import type { ClientEvent } from '../../shared/protocol.ts'
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
  ws.on('close', () => {
    viewers.drop(ws)
    d.terminals.drop(ws)
  })
}

async function handle(ws: WebSocket, event: ClientEvent, d: BrowserDeps): Promise<void> {
  switch (event.type) {
    case 'subscribe':
      return d.chats.subscribe(ws, event.sessionId)
    case 'unsubscribe':
      return d.viewers.unwatch(ws, event.sessionId)
    case 'seen':
      return d.attention.mark(event.sessionId, false)
    case 'term_subscribe':
      return d.terminals.subscribe(ws, event.id)
    case 'term_unsubscribe':
      return d.terminals.unsubscribe(ws, event.id)
    case 'term_input':
      return d.terminals.input(event.id, event.data)
    case 'term_resize':
      return d.terminals.resize(event.id, event.cols, event.rows)
    case 'preview_url':
      if (/^https?:\/\/\{port\}\.[a-z0-9.-]+(:\d+)?$/i.test(event.url)) d.viewers.setPreviewUrl(ws, event.url)
      return
    case 'client_error': {
      const text = (v: string) => v.slice(0, 4000)
      console.error(`[browser] ${text(event.message)} at ${text(event.url)}${event.stack ? `\n${text(event.stack)}` : ''}`)
      return
    }
    default:
      return d.chats.handle(ws, event)
  }
}
