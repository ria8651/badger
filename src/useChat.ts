import { onCleanup } from 'solid-js'
import { createStore, produce } from 'solid-js/store'
import type { PendingPermission, PermissionMode, ServerEvent, WireMessage } from '../shared/protocol.ts'
import { socket } from './api.ts'

/** The block currently streaming in, before its full assistant message lands. */
export interface Partial {
  messageId: string
  type: 'text' | 'thinking' | 'tool_use'
  text: string
  toolName?: string
}

export interface ChatState {
  loaded: boolean
  messages: WireMessage[]
  partial: Partial | null
  running: boolean
  mode: PermissionMode
  cwd?: string
  permissions: PendingPermission[]
  error: string | null
}

function apply(state: ChatState, event: ServerEvent): void {
  switch (event.type) {
    case 'snapshot':
      state.loaded = true
      state.messages = event.messages
      state.running = event.running
      state.mode = event.mode
      state.cwd = event.cwd
      state.permissions = event.permissions
      state.partial = null
      break
    case 'status':
      state.running = event.running
      state.mode = event.mode
      if (!event.running) state.partial = null
      break
    case 'permission_request':
      state.permissions.push(event.permission)
      break
    case 'permission_resolved':
      state.permissions = state.permissions.filter((p) => p.requestId !== event.requestId)
      break
    case 'error':
      state.error = event.error
      break
    case 'message':
      applyMessage(state, event.message)
      break
  }
}

function applyMessage(state: ChatState, msg: WireMessage): void {
  if (msg.type === 'stream_event') {
    if (!msg.parent_tool_use_id) applyStreamEvent(state, msg.event as StreamEvent)
    return
  }
  if (msg.uuid && state.messages.some((m) => m.uuid === msg.uuid)) return
  const id = (msg.message as { id?: string } | undefined)?.id
  if ((msg.type === 'assistant' && id === state.partial?.messageId) || msg.type === 'result') state.partial = null
  state.messages.push(msg)
}

type StreamEvent =
  | { type: 'message_start'; message: { id: string } }
  | { type: 'content_block_start'; index: number; content_block: { type: string; name?: string } }
  | { type: 'content_block_delta'; delta: { type: string; text?: string; thinking?: string; partial_json?: string } }
  | { type: string }

let currentMessageId = ''

function applyStreamEvent(state: ChatState, e: StreamEvent): void {
  if (e.type === 'message_start' && 'message' in e) {
    currentMessageId = e.message.id
    state.partial = null
  } else if (e.type === 'content_block_start' && 'content_block' in e) {
    const t = e.content_block.type
    state.partial =
      t === 'text' || t === 'thinking' || t === 'tool_use'
        ? { messageId: currentMessageId, type: t, text: '', toolName: e.content_block.name }
        : null
  } else if (e.type === 'content_block_delta' && 'delta' in e && state.partial) {
    const d = e.delta
    state.partial.text += d.text ?? d.thinking ?? d.partial_json ?? ''
  }
}

/** Subscribes to one session for the lifetime of the calling component. */
export function createChat(sessionId: string) {
  const [state, setState] = createStore<ChatState>({
    loaded: false,
    messages: [],
    partial: null,
    running: false,
    mode: 'default',
    permissions: [],
    error: null,
  })

  const off = socket.on((event) => {
    if ('sessionId' in event && event.sessionId === sessionId) setState(produce((s) => apply(s, event)))
  })
  socket.send({ type: 'subscribe', sessionId })
  onCleanup(() => {
    off()
    socket.send({ type: 'unsubscribe', sessionId })
  })

  return { state, clearError: () => setState('error', null) }
}
