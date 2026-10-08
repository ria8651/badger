/**
 * Wire protocol between the browser and the server over a single WebSocket.
 * SDK messages are forwarded mostly verbatim; the client renders them.
 */

export type PermissionMode = 'default' | 'acceptEdits' | 'auto' | 'plan' | 'bypassPermissions'

export interface PendingPermission {
  requestId: string
  toolName: string
  toolUseId?: string
  input: Record<string, unknown>
  /** True when the SDK offered rules that would make this an "always allow". */
  canAlwaysAllow: boolean
  blockedPath?: string
}

export interface SessionSummary {
  id: string
  title: string
  cwd?: string
  lastModified: number
  running: boolean
  /** Hidden from the sidebar's main list. Archiving never deletes the transcript. */
  archived: boolean
}

export const CARD_STATUSES = ['backlog', 'todo', 'in_progress', 'review', 'done'] as const
export type CardStatus = (typeof CARD_STATUSES)[number]

/** A unit of work. Cards live in Badger's database, not a repo, so one card can hold chats from several repos. */
export interface Card {
  id: number
  title: string
  description: string
  status: CardStatus
  /** Sort order within the status column; fractional so a card can drop between two others. */
  position: number
  createdAt: number
  updatedAt: number
  sessionIds: string[]
}

/**
 * A terminal owned by the PTY host. It belongs to the server, not to a chat:
 * it keeps running across chats, reloads and Badger server restarts.
 */
export interface TerminalInfo {
  /** Short hex id. */
  id: string
  /** What the program last set as its title (shells usually show the running command), else the command or shell. */
  title: string
  cwd: string
  /** Git root of cwd (each worktree is its own), or cwd outside a repo. Terminals are grouped by this. */
  root: string
  /** Run with bash -c; restarting runs it again. Absent for an interactive shell. */
  command?: string
  /** The chat whose Claude started it, if any. */
  sessionId?: string
  running: boolean
  exitCode?: number
  /** Set when the process was killed by a signal. */
  signal?: number
  createdAt: number
}

/** Anything the SDK emits, or a transcript entry read back from disk. */
export type WireMessage = { type: string; uuid?: string; [key: string]: unknown }

export type ClientEvent =
  | { type: 'subscribe'; sessionId: string }
  | { type: 'unsubscribe'; sessionId: string }
  | { type: 'send'; sessionId: string; text: string; cwd?: string; mode?: PermissionMode }
  | { type: 'interrupt'; sessionId: string }
  /** The composer's unsent text; replaces the saved draft. */
  | { type: 'draft'; sessionId: string; text: string }
  | { type: 'set_mode'; sessionId: string; mode: PermissionMode }
  | {
      type: 'permission'
      sessionId: string
      requestId: string
      decision: 'allow' | 'allow_always' | 'deny'
      message?: string
      /** Replacement tool input, e.g. AskUserQuestion answers. */
      updatedInput?: Record<string, unknown>
    }
  | { type: 'term_subscribe'; id: string }
  | { type: 'term_unsubscribe'; id: string }
  | { type: 'term_input'; id: string; data: string }
  | { type: 'term_resize'; id: string; cols: number; rows: number }

export type ServerEvent =
  | {
      type: 'snapshot'
      sessionId: string
      messages: WireMessage[]
      running: boolean
      mode: PermissionMode
      cwd?: string
      permissions: PendingPermission[]
      /** Output so far of Bash commands still running, by tool_use_id. */
      bashOutput: Record<string, string>
      /** Unsent composer text, in the same message as the transcript so they arrive together. */
      draft: string
    }
  | { type: 'message'; sessionId: string; message: WireMessage }
  /** Another viewer changed the chat's unsent text. */
  | { type: 'draft'; sessionId: string; text: string }
  /** Live output from a running Bash command; the tool_result still carries the final output. */
  | { type: 'bash_output'; sessionId: string; toolUseId: string; chunk: string }
  | { type: 'status'; sessionId: string; running: boolean; mode: PermissionMode }
  | { type: 'permission_request'; sessionId: string; permission: PendingPermission }
  | { type: 'permission_resolved'; sessionId: string; requestId: string }
  | { type: 'sessions_changed' }
  | { type: 'cards_changed' }
  /** Every terminal; sent on connect and whenever any of them changes. */
  | { type: 'terminals'; terminals: TerminalInfo[] }
  /** The terminal's screen and scrollback as escape sequences; replaces whatever the viewer had. */
  | { type: 'term_snapshot'; id: string; data: string }
  | { type: 'term_output'; id: string; data: string }
  | { type: 'error'; sessionId?: string; error: string }
