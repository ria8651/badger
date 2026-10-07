import { useEffect, useReducer } from 'react'
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

const initial: ChatState = {
  loaded: false,
  messages: [],
  partial: null,
  running: false,
  mode: 'default',
  permissions: [],
  error: null,
}

type Action = ServerEvent | { type: 'reset' } | { type: 'clear_error' }

function reducer(state: ChatState, action: Action): ChatState {
  switch (action.type) {
    case 'reset':
      return initial
    case 'clear_error':
      return { ...state, error: null }
    case 'snapshot':
      return {
        ...state,
        loaded: true,
        messages: action.messages,
        running: action.running,
        mode: action.mode,
        cwd: action.cwd,
        permissions: action.permissions,
        partial: null,
      }
    case 'status':
      return { ...state, running: action.running, mode: action.mode, partial: action.running ? state.partial : null }
    case 'permission_request':
      return { ...state, permissions: [...state.permissions, action.permission] }
    case 'permission_resolved':
      return { ...state, permissions: state.permissions.filter((p) => p.requestId !== action.requestId) }
    case 'error':
      return { ...state, error: action.error }
    case 'message':
      return applyMessage(state, action.message)
    default:
      return state
  }
}

function applyMessage(state: ChatState, msg: WireMessage): ChatState {
  if (msg.type === 'stream_event') {
    if (msg.parent_tool_use_id) return state
    return { ...state, partial: applyStreamEvent(state.partial, msg.event as StreamEvent) }
  }
  if (msg.uuid && state.messages.some((m) => m.uuid === msg.uuid)) return state
  let partial = state.partial
  const id = (msg.message as { id?: string } | undefined)?.id
  if ((msg.type === 'assistant' && id === partial?.messageId) || msg.type === 'result') partial = null
  return { ...state, messages: [...state.messages, msg], partial }
}

type StreamEvent =
  | { type: 'message_start'; message: { id: string } }
  | { type: 'content_block_start'; index: number; content_block: { type: string; name?: string } }
  | { type: 'content_block_delta'; delta: { type: string; text?: string; thinking?: string; partial_json?: string } }
  | { type: string }

let currentMessageId = ''

function applyStreamEvent(partial: Partial | null, e: StreamEvent): Partial | null {
  if (e.type === 'message_start' && 'message' in e) {
    currentMessageId = e.message.id
    return null
  }
  if (e.type === 'content_block_start' && 'content_block' in e) {
    const t = e.content_block.type
    if (t !== 'text' && t !== 'thinking' && t !== 'tool_use') return null
    return { messageId: currentMessageId, type: t, text: '', toolName: e.content_block.name }
  }
  if (e.type === 'content_block_delta' && 'delta' in e && partial) {
    const d = e.delta
    const add = d.text ?? d.thinking ?? d.partial_json ?? ''
    return { ...partial, text: partial.text + add }
  }
  return partial
}

export function useChat(sessionId: string | null) {
  const [state, dispatch] = useReducer(reducer, initial)

  useEffect(() => {
    dispatch({ type: 'reset' })
    if (!sessionId) return
    const off = socket.on((event) => {
      if ('sessionId' in event && event.sessionId === sessionId) dispatch(event)
    })
    socket.send({ type: 'subscribe', sessionId })
    return () => {
      off()
      socket.send({ type: 'unsubscribe', sessionId })
    }
  }, [sessionId])

  return { state, clearError: () => dispatch({ type: 'clear_error' }) }
}
