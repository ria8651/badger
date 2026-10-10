import { createContext, onCleanup, useContext } from 'solid-js'
import { createStore, produce } from 'solid-js/store'
import type { BackgroundTask, ContextUsage, PendingPermission, PermissionMode, ServerEvent, WireMessage } from '../shared/protocol.ts'
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
  /** Absent for a chat that hasn't run yet. */
  model?: string
  cwd?: string
  /** Its folder is gone or can't be opened, so it can't take messages. */
  gone: boolean
  permissions: PendingPermission[]
  /** Live output of running Bash commands, by tool_use_id. */
  bashOutput: Record<string, string>
  /** Chats this one started from a tool call, by that call's tool_use_id. */
  children: Record<string, string>
  /** Subagents, shells and the like running in the background now. */
  background: BackgroundTask[]
  /** How full the context window is; absent until Claude Code has said. */
  context?: ContextUsage
  error: string | null
}

/** Live Bash output kept per command; the final tool_result has the full text. */
const BASH_KEEP = 64 * 1024

function apply(state: ChatState, event: ServerEvent): void {
  switch (event.type) {
    case 'snapshot':
      state.loaded = true
      state.messages = event.messages
      state.running = event.running
      state.mode = event.mode
      state.model = event.model
      state.cwd = event.cwd
      state.gone = !!event.gone
      state.permissions = event.permissions
      state.bashOutput = event.bashOutput
      state.children = event.children
      state.background = event.background
      state.partial = null
      break
    case 'background':
      state.background = event.tasks
      break
    case 'context':
      state.context = event.usage
      break
    case 'child_started':
      state.children[event.toolUseId] = event.childId
      break
    case 'status':
      state.running = event.running
      state.mode = event.mode
      if (event.model) state.model = event.model
      state.cwd = event.cwd
      if (!event.running) state.partial = null
      break
    case 'permission_request':
      state.permissions.push(event.permission)
      break
    case 'answer_draft': {
      const p = state.permissions.find((p) => p.requestId === event.requestId)
      if (p) p.answers = event.answers
      break
    }
    case 'permission_resolved':
      state.permissions = state.permissions.filter((p) => p.requestId !== event.requestId)
      break
    case 'bash_output':
      state.bashOutput[event.toolUseId] = ((state.bashOutput[event.toolUseId] ?? '') + event.chunk).slice(-BASH_KEEP)
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
    mode: 'auto',
    gone: false,
    permissions: [],
    bashOutput: {},
    children: {},
    background: [],
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

/**
 * Child chats' state, by session id, for everything inside the chat that
 * started them. The chat subscribes to each child once, so its tool call and
 * its permission prompts read the same state.
 */
export const ChildChats = createContext<(sessionId: string) => ChatState | undefined>(() => undefined)
export const useChildChat = (sessionId: string) => useContext(ChildChats)(sessionId)
