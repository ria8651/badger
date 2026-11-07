import { createContext, createMemo, mapArray, onCleanup, useContext } from 'solid-js'
import { createStore, produce } from 'solid-js/store'
import {
  NO_DRAFT,
  changeDraft,
  type BackgroundTask,
  type ClientEvent,
  type ContextUsage,
  type Draft,
  type DraftAttachments,
  type PendingPermission,
  type PermissionMode,
  type QueuedMessage,
  type ServerEvent,
  type StartAt,
  type WireMessage,
} from '../shared/protocol.ts'
import { socket } from './api.ts'

/** What the composer changes of a draft: what's typed, saved after a pause in typing, or what's attached, saved at once. */
export type DraftEdit = { text?: string; attachments?: DraftAttachments }

/** The block currently streaming in, before its full assistant message lands. */
export interface Partial {
  messageId: string
  type: 'text' | 'thinking' | 'tool_use'
  text: string
  toolName?: string
}

export interface ChatState {
  loaded: boolean
  /** What's in its composer and not sent, as last saved by any tab on it. */
  draft: Draft
  messages: WireMessage[]
  partial: Partial | null
  running: boolean
  /** Claude Code is still making the worktree it was started in, so nothing's happening yet. */
  makingWorktree: boolean
  /** When Claude Code started compacting the conversation, while it is. */
  compacting?: number
  mode: PermissionMode
  /** Absent for a chat that hasn't run yet. */
  model?: string
  cwd?: string
  /** The machine it runs on; absent for a chat that hasn't started. */
  machine?: string
  /** Its folder is gone or can't be opened, so it can't take messages. */
  gone: boolean
  permissions: PendingPermission[]
  /** Live output of running Bash commands, by tool_use_id. */
  bashOutput: Record<string, string>
  /** Calls auto mode is still deciding whether to allow, by tool_use_id. */
  checking: string[]
  /** Chats this one started from a tool call, by that call's tool_use_id. */
  children: Record<string, string>
  /** Subagents, shells and the like running in the background now. */
  background: BackgroundTask[]
  /** Sent while Claude was working and not gone out yet. */
  queued: QueuedMessage[]
  /** How full the context window is; absent until Claude Code has said. */
  context?: ContextUsage
  error: string | null
}

/** Live Bash output kept per command; the final tool_result has the full text. */
const BASH_KEEP = 64 * 1024

/** Per chat, and not state anyone reads: the message whose blocks are streaming in. Children stream alongside their parent. */
interface Stream {
  messageId: string
}

function apply(state: ChatState, event: ServerEvent, stream: Stream): void {
  switch (event.type) {
    case 'snapshot':
      state.loaded = true
      state.draft = event.draft
      state.messages = event.messages
      state.running = event.running
      state.makingWorktree = !!event.makingWorktree
      state.compacting = event.compacting
      state.mode = event.mode
      state.model = event.model
      state.cwd = event.cwd
      state.machine = event.machine
      state.gone = !!event.gone
      state.permissions = event.permissions
      state.bashOutput = event.bashOutput
      state.checking = event.checking ?? []
      state.children = event.children
      state.background = event.background
      state.queued = event.queued
      state.partial = null
      break
    case 'background':
      state.background = event.tasks
      break
    case 'draft': {
      const { type, sessionId, ...change } = event
      state.draft = changeDraft(state.draft, change)
      break
    }
    case 'queued':
      state.queued = event.messages
      break
    case 'context':
      state.context = event.usage
      break
    case 'child_started':
      state.children[event.toolUseId] = event.childId
      break
    case 'status':
      state.running = event.running
      state.makingWorktree = event.makingWorktree
      state.compacting = event.compacting
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
    case 'plan_draft': {
      const p = state.permissions.find((p) => p.requestId === event.requestId)
      if (p) p.plan = event.plan
      break
    }
    case 'permission_resolved':
      state.permissions = state.permissions.filter((p) => p.requestId !== event.requestId)
      break
    case 'bash_output':
      state.bashOutput[event.toolUseId] = ((state.bashOutput[event.toolUseId] ?? '') + event.chunk).slice(-BASH_KEEP)
      break
    case 'checking':
      state.checking = event.toolUseIds
      break
    case 'error':
      state.error = event.error
      break
    case 'message':
      applyMessage(state, event.message, stream)
      break
  }
}

function applyMessage(state: ChatState, msg: WireMessage, stream: Stream): void {
  if (msg.type === 'stream_event') {
    if (!msg.parent_tool_use_id) applyStreamEvent(state, msg.event as StreamEvent, stream)
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

function applyStreamEvent(state: ChatState, e: StreamEvent, stream: Stream): void {
  if (e.type === 'message_start' && 'message' in e) {
    stream.messageId = e.message.id
    state.partial = null
  } else if (e.type === 'content_block_start' && 'content_block' in e) {
    const t = e.content_block.type
    state.partial =
      t === 'text' || t === 'thinking' || t === 'tool_use'
        ? { messageId: stream.messageId, type: t, text: '', toolName: e.content_block.name }
        : null
  } else if (e.type === 'content_block_delta' && 'delta' in e && state.partial) {
    const d = e.delta
    state.partial.text += d.text ?? d.thinking ?? d.partial_json ?? ''
  }
}

/**
 * What can be asked of a chat that needs nothing but its id, for anything that has one: a task's row in a
 * transcript, the task tray. A chat's own view has these from createChat too.
 */
export const chatCommands = (sessionId: string) => ({
  interrupt: () => socket.send({ type: 'interrupt', sessionId }),
  setMode: (mode: PermissionMode) => socket.send({ type: 'set_mode', sessionId, mode }),
  setModel: (model: string) => socket.send({ type: 'set_model', sessionId, model }),
  /** Takes a queued message back; to edit, it goes back into the composer, ahead of what's typed there. */
  unqueue: (id: string, edit = false) => socket.send({ type: 'unqueue', sessionId, id, edit }),
  stopTask: (taskId: string) => socket.send({ type: 'stop_task', sessionId, taskId }),
  /** Stop waiting on a running subagent or command, leaving it to finish in the background; without an id, every one. */
  background: (toolUseId?: string) => socket.send({ type: 'background_task', sessionId, toolUseId }),
})

/** A message going out: what's typed and attached, and for a chat that hasn't started, where and how it runs. */
export type Outgoing = Omit<Extract<ClientEvent, { type: 'send' }>, 'type' | 'sessionId'>

/**
 * Subscribes to one session for the lifetime of the calling component. Returns its state and what can be asked of it.
 * While it hasn't started, `start` says where it will run, which is kept with its draft.
 */
export function createChat(sessionId: string, start?: () => StartAt | undefined) {
  const [state, setState] = createStore<ChatState>({
    draft: NO_DRAFT,
    loaded: false,
    messages: [],
    partial: null,
    running: false,
    makingWorktree: false,
    mode: 'auto',
    gone: false,
    permissions: [],
    bashOutput: {},
    checking: [],
    children: {},
    background: [],
    queued: [],
    error: null,
  })

  const stream: Stream = { messageId: '' }
  const off = socket.on((event) => {
    if ('sessionId' in event && event.sessionId === sessionId) setState(produce((s) => apply(s, event, stream)))
  })
  socket.send({ type: 'subscribe', sessionId })
  onCleanup(() => {
    off()
    socket.send({ type: 'unsubscribe', sessionId })
  })

  /** Saves parts of the draft on the server, so it survives leaving the chat or reloading, and every tab on it shows the same. */
  const save = (change: DraftEdit & { start?: StartAt }) => {
    // Replaced, not merged: setState('draft', change) would write into the object there, which can be NO_DRAFT.
    setState({ draft: changeDraft(state.draft, change) })
    socket.send({ type: 'draft', sessionId, ...change })
  }

  return {
    state,
    ...chatCommands(sessionId),
    clearError: () => setState('error', null),
    send: (message: Outgoing) => socket.send({ type: 'send', sessionId, ...message }),
    /** The draft went out as a message; the server clears its copy when the message arrives. Where it was to start stays until the chat says where it did. */
    clearDraft: () => setState({ draft: { ...NO_DRAFT, start: state.draft.start } }),
    /** A chat that hasn't started keeps where it will run with what's typed, so that stays put while it waits. */
    editDraft: (edit: DraftEdit) => {
      const at = start?.()
      save(at ? { ...edit, start: at } : edit)
    },
    /** Picks where a chat that hasn't started will run. */
    startAt: (at: StartAt) => save({ start: at }),
  }
}

export type Chat = ReturnType<typeof createChat>

/**
 * A subagent as a chat of its own, inside the chat running it, to read: it reads that chat's state, its own
 * conversation being the messages from its call. Nothing is sent to it from here; that's for the chat's Claude.
 * Stopping it stops just it.
 */
export function agentChat(parent: Chat, agent: { toolUseId: string; running: () => boolean; stop: () => void }): Chat {
  const own: { [K in keyof ChatState]?: () => unknown } = {
    draft: () => NO_DRAFT,
    running: agent.running,
    partial: () => null,
    makingWorktree: () => false,
    compacting: () => undefined,
    queued: () => [],
    // Not the parent's: its context window and its errors.
    context: () => undefined,
    error: () => null,
  }
  const state = new Proxy(parent.state, {
    get: (target, prop, receiver) => (Object.hasOwn(own, prop) ? own[prop as keyof ChatState]!() : Reflect.get(target, prop, receiver)),
  })
  return {
    ...parent,
    state,
    interrupt: agent.stop,
    background: () => parent.background(agent.toolUseId),
    startAt: () => {},
  }
}

/**
 * Chats this one started and waits on, subscribed once for its lifetime, so a child's tool call and its
 * permission prompts read the same state. Mapped over tool_use_ids, which are strings, so adding a child never
 * resubscribes the others.
 */
export function createChildChats(state: ChatState) {
  const children = mapArray(
    createMemo(() => Object.keys(state.children)),
    (toolUseId) => {
      const id = state.children[toolUseId]
      return { id, toolUseId, state: createChat(id).state }
    },
  )
  /** The tool that started a child, to say whose prompt it is. */
  const toolName = (toolUseId: string) => {
    for (const m of state.messages) {
      const content = (m.message as { content?: { type: string; id?: string; name?: string }[] } | undefined)?.content
      const use = Array.isArray(content) && content.find((b) => b.type === 'tool_use' && b.id === toolUseId)
      if (use) return use.name ?? ''
    }
    return ''
  }
  return {
    /** A child's state, by its session id. */
    state: (id: string) => children().find((c) => c.id === id)?.state,
    /** Every child's pending prompts, with the child and the name of the tool that started it. */
    prompts: () => children().flatMap((c) => c.state.permissions.map((p) => ({ child: c, tool: toolName(c.toolUseId), permission: p }))),
  }
}

/** Child chats' state, by session id, for everything inside the chat that started them. */
export const ChildChats = createContext<(sessionId: string) => ChatState | undefined>(() => undefined)

/** Whether auto mode is still deciding on a call, by tool_use_id. */
export const Checking = createContext<(toolUseId: string) => boolean>(() => false)
export const useChecking = () => useContext(Checking)
