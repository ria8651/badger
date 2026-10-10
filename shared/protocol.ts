/**
 * Wire protocol between the browser and the server over a single WebSocket.
 * SDK messages are forwarded mostly verbatim; the client renders them.
 */

export type PermissionMode = 'default' | 'acceptEdits' | 'auto' | 'plan' | 'bypassPermissions'

/** A model Claude Code offers, as its model picker lists it. */
export interface ModelOption {
  /** What to pass to Claude Code: an alias like `opus`, a model id, or `default`. */
  value: string
  /** The model id it stands for, which is what transcripts record. */
  resolvedModel?: string
  displayName: string
  description: string
}

export interface PendingPermission {
  requestId: string
  toolName: string
  toolUseId?: string
  input: Record<string, unknown>
  /** True when the SDK offered rules that would make this an "always allow". */
  canAlwaysAllow: boolean
  blockedPath?: string
  /** Set when a subagent asked: its description. */
  agent?: string
  /** AskUserQuestion answers picked so far but not sent. */
  answers?: AnswerDraft
}

/** Half-finished AskUserQuestion answers, by question text. */
export type AnswerDraft = { picked: Record<string, string[]>; other: Record<string, string> }

/** Work Claude Code runs alongside the conversation: a background subagent, shell, monitor or workflow. */
export interface BackgroundTask {
  /** Claude Code's task id; a subagent's is its agent id. */
  id: string
  /** e.g. local_agent, local_bash, monitor, local_workflow. */
  type: string
  description: string
}

export interface SessionSummary {
  id: string
  title: string
  cwd?: string
  lastModified: number
  running: boolean
  /** Hidden from the sidebar's main list. Archiving never deletes the transcript. */
  archived: boolean
  /** Its directory no longer exists, e.g. a removed worktree. */
  gone?: boolean
}

/** A git worktree Claude Code made under `<repo>/.claude/worktrees/`. */
export interface WorktreeStatus {
  path: string
  branch: string
  /** Files with uncommitted changes. */
  changes: number
  /** Commits on its branch that the main checkout's HEAD doesn't have. */
  unmerged: number
  /** The main checkout's branch, which `unmerged` is counted against. */
  base: string
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

export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const

/** A pasted or dropped image, base64 encoded, sent to Claude as an image block. */
export type ImageAttachment = { mediaType: (typeof IMAGE_TYPES)[number]; data: string }

/** Big pastes and images waiting in the composer to be sent. */
export type DraftAttachments = { pastes: string[]; images: ImageAttachment[] }

/** Anything the SDK emits, or a transcript entry read back from disk. */
export type WireMessage = { type: string; uuid?: string; [key: string]: unknown }

export type ClientEvent =
  | { type: 'subscribe'; sessionId: string }
  | { type: 'unsubscribe'; sessionId: string }
  | {
      type: 'send'
      sessionId: string
      text: string
      /** Big pastes, sent after the text as attachments. */
      pastes?: string[]
      images?: ImageAttachment[]
      cwd?: string
      mode?: PermissionMode
      /** Used when this starts or resumes the chat's process; a running one keeps its model. */
      model?: string
      /** Start a new chat in a git worktree of cwd with this name (reused if it exists); empty lets Claude name it. */
      worktree?: string
    }
  | { type: 'interrupt'; sessionId: string }
  /** Stop one subagent or background task, leaving the rest of the chat running. */
  | { type: 'stop_task'; sessionId: string; taskId: string }
  /** The composer's unsent text and attachments; each one given replaces what's saved. */
  | { type: 'draft'; sessionId: string; text?: string; attachments?: DraftAttachments }
  | { type: 'set_mode'; sessionId: string; mode: PermissionMode }
  | { type: 'set_model'; sessionId: string; model: string }
  | {
      type: 'permission'
      sessionId: string
      requestId: string
      decision: 'allow' | 'allow_always' | 'deny'
      message?: string
      /** Replacement tool input, e.g. AskUserQuestion answers. */
      updatedInput?: Record<string, unknown>
    }
  /** Answers picked so far in a pending AskUserQuestion; replaces what's saved. */
  | { type: 'answer_draft'; sessionId: string; requestId: string; answers: AnswerDraft }
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
      /** A ModelOption value, or a model id from the transcript. Absent until the chat has run. */
      model?: string
      cwd?: string
      permissions: PendingPermission[]
      /** Output so far of Bash commands still running, by tool_use_id. */
      bashOutput: Record<string, string>
      /** Unsent composer text, in the same message as the transcript so they arrive together. */
      draft: string
      draftAttachments: DraftAttachments
      /** Chats this one started from a tool call and waited on, by that call's tool_use_id. */
      children: Record<string, string>
      background: BackgroundTask[]
    }
  | { type: 'message'; sessionId: string; message: WireMessage }
  /** Another viewer changed the chat's unsent text or attachments. */
  | { type: 'draft'; sessionId: string; text?: string; attachments?: DraftAttachments }
  /** Live output from a running Bash command; the tool_result still carries the final output. */
  | { type: 'bash_output'; sessionId: string; toolUseId: string; chunk: string }
  /** cwd changes when the chat moves into a worktree. */
  | { type: 'status'; sessionId: string; running: boolean; mode: PermissionMode; model?: string; cwd: string }
  /** The background tasks running now; replaces the previous set. */
  | { type: 'background'; sessionId: string; tasks: BackgroundTask[] }
  | { type: 'permission_request'; sessionId: string; permission: PendingPermission }
  /** Another viewer changed the answers picked in a pending AskUserQuestion. */
  | { type: 'answer_draft'; sessionId: string; requestId: string; answers: AnswerDraft }
  | { type: 'permission_resolved'; sessionId: string; requestId: string }
  /** The chat started a child chat from a tool call; it's shown inside that call. */
  | { type: 'child_started'; sessionId: string; toolUseId: string; childId: string }
  | { type: 'sessions_changed' }
  | { type: 'cards_changed' }
  /** Every terminal; sent on connect and whenever any of them changes. */
  | { type: 'terminals'; terminals: TerminalInfo[] }
  /** The terminal's screen and scrollback as escape sequences; replaces whatever the viewer had. */
  | { type: 'term_snapshot'; id: string; data: string }
  | { type: 'term_output'; id: string; data: string }
  | { type: 'error'; sessionId?: string; error: string }
