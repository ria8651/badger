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

/**
 * Why a chat needs the user: a prompt or question is waiting on them, or a
 * turn ended that they haven't looked at yet.
 */
export type AttentionState = 'waiting' | 'unread'

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

/** How full a chat's context window is, as Claude Code's /context counts it. */
export interface ContextUsage {
  /** Tokens in the window now. */
  tokens: number
  /** The window it's measured against: where autocompact kicks in, which may be below the model's limit. */
  max: number
  /** tokens / max, rounded, 0-100+. */
  percent: number
  /** 'used' rows fill the window, 'free' is what's left, 'buffer' is kept back for compacting, 'deferred' tools aren't loaded. */
  categories: { name: string; tokens: number; kind: 'used' | 'free' | 'buffer' | 'deferred' }[]
}

/** The account's plan limits, as Claude Code's /usage shows them. */
export interface AccountUsage {
  /** e.g. pro, max, team, enterprise; null for an API key. */
  plan: string | null
  /** In the order the server gives them. Empty when plan limits don't apply, e.g. with an API key. */
  limits: { label: string; percent: number; severity: string; resetsAt: string | null }[]
  /** When this was read, ms since epoch. */
  at: number
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

/**
 * A unit of work. Cards live in Badger's database, not a repo, so one card can hold chats from several repos.
 * Any card can hold cards of its own, shown as its own board; a project is just a card that has some.
 */
export interface Card {
  id: number
  /** The card this one sits on the board of, or null for the top-level board. */
  parentId: number | null
  title: string
  description: string
  status: CardStatus
  /** Sort order within the status column; fractional so a card can drop between two others. */
  position: number
  createdAt: number
  updatedAt: number
  /** When it last changed column, from the audit log; editing it otherwise doesn't move this. */
  statusChangedAt: number
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
  /** The process the terminal runs, while it's running. */
  pid?: number
  /** TCP ports it or anything it started is listening on, e.g. a dev server's. */
  ports?: number[]
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

/** A message sent while Claude was busy, which Claude Code holds until its next break; it can be withdrawn until then. */
export interface QueuedMessage {
  id: string
  text: string
  pastes: string[]
  images: ImageAttachment[]
}

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
  /** Withdraw a queued message if Claude Code hasn't taken it in; with edit, it goes back into the composer ahead of what's typed there. */
  | { type: 'unqueue'; sessionId: string; id: string; edit?: boolean }
  /** Stop one subagent or background task, leaving the rest of the chat running. */
  | { type: 'stop_task'; sessionId: string; taskId: string }
  /** Stop waiting on a running subagent or command and let it carry on in the background; without toolUseId, every one. */
  | { type: 'background_task'; sessionId: string; toolUseId?: string }
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
  /** The user is looking at this chat, so it's no longer unread. */
  | { type: 'seen'; sessionId: string }
  | { type: 'term_subscribe'; id: string }
  | { type: 'term_unsubscribe'; id: string }
  | { type: 'term_input'; id: string; data: string }
  | { type: 'term_resize'; id: string; cols: number; rows: number }
  /** Where this browser reaches previews, with `{port}` for the port, e.g. `https://{port}.badger.example.com`. */
  | { type: 'preview_url'; url: string }

export type ServerEvent =
  | {
      type: 'snapshot'
      sessionId: string
      messages: WireMessage[]
      running: boolean
      /** Claude Code is still making the worktree it was started in, so nothing's happening yet. */
      makingWorktree?: boolean
      mode: PermissionMode
      /** A ModelOption value, or a model id from the transcript. Absent until the chat has run. */
      model?: string
      cwd?: string
      /** Its folder is gone or can't be opened, e.g. a worktree removed after merging, so it can't run. */
      gone?: boolean
      permissions: PendingPermission[]
      /** Output so far of Bash commands still running, by tool_use_id. */
      bashOutput: Record<string, string>
      /** Unsent composer text, in the same message as the transcript so they arrive together. */
      draft: string
      draftAttachments: DraftAttachments
      /** Chats this one started from a tool call and waited on, by that call's tool_use_id. */
      children: Record<string, string>
      background: BackgroundTask[]
      queued: QueuedMessage[]
    }
  | { type: 'message'; sessionId: string; message: WireMessage }
  /** Another viewer changed the chat's unsent text or attachments. */
  | { type: 'draft'; sessionId: string; text?: string; attachments?: DraftAttachments }
  /** Live output from a running Bash command; the tool_result still carries the final output. */
  | { type: 'bash_output'; sessionId: string; toolUseId: string; chunk: string }
  /** cwd changes when the chat moves into a worktree. */
  | { type: 'status'; sessionId: string; running: boolean; makingWorktree: boolean; mode: PermissionMode; model?: string; cwd: string }
  /** Messages Claude Code is holding for its next break; replaces the previous list. */
  | { type: 'queued'; sessionId: string; messages: QueuedMessage[] }
  /** The background tasks running now; replaces the previous set. */
  | { type: 'background'; sessionId: string; tasks: BackgroundTask[] }
  /** The chat's context window after its latest turn; sent after each one and on subscribe. */
  | { type: 'context'; sessionId: string; usage: ContextUsage }
  /** Plan limits; sent on connect and whenever they're read again. */
  | { type: 'account_usage'; usage: AccountUsage }
  | { type: 'permission_request'; sessionId: string; permission: PendingPermission }
  /** Another viewer changed the answers picked in a pending AskUserQuestion. */
  | { type: 'answer_draft'; sessionId: string; requestId: string; answers: AnswerDraft }
  | { type: 'permission_resolved'; sessionId: string; requestId: string }
  /** The chat started a child chat from a tool call; it's shown inside that call. */
  | { type: 'child_started'; sessionId: string; toolUseId: string; childId: string }
  | { type: 'sessions_changed' }
  /** Every chat that needs the user, by id; sent on connect and whenever it changes. Children count as their parent. */
  | { type: 'attention'; chats: Record<string, AttentionState> }
  | { type: 'cards_changed' }
  /** Every terminal; sent on connect and whenever any of them changes. */
  | { type: 'terminals'; terminals: TerminalInfo[] }
  /** The terminal's screen and scrollback as escape sequences; replaces whatever the viewer had. */
  | { type: 'term_snapshot'; id: string; data: string }
  | { type: 'term_output'; id: string; data: string }
  /** Claude asked to show a port's preview in the workspace's panels. */
  | { type: 'open_preview'; root: string; port: number; name?: string; path?: string }
  | { type: 'error'; sessionId?: string; error: string }
