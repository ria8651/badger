/**
 * Wire protocol between the browser and the server over a single WebSocket.
 * SDK messages are forwarded mostly verbatim; the client renders them.
 */

export const PERMISSION_MODES = ['default', 'acceptEdits', 'auto', 'plan', 'bypassPermissions'] as const
export type PermissionMode = (typeof PERMISSION_MODES)[number]

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
  /** ExitPlanMode's plan as edited so far, not yet sent. */
  plan?: string
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

/**
 * A computer chats and terminals run on: the hub's own, or another one whose
 * runner (`pnpm remote`) connects to the hub. A chat stays on the machine it
 * started on. The UI calls these runners.
 */
export interface Machine {
  id: string
  name: string
  /** The hub's own. It's always there, has no token and can't be removed. */
  local: boolean
  online: boolean
  /** Its host's name and OS (Node's process.platform), as its runner last said. */
  hostname?: string
  platform?: string
  /** Where new chats start on it by default. Known once it has connected. */
  workspaceDir?: string
  /** Where its folderless chats run. */
  scratchDir?: string
  /** When it was last connected, ms since epoch; absent if it never has been. */
  lastSeen?: number
  /** Chats working on it now. */
  running: number
  /** Why the hub last turned its runner away, e.g. a version mismatch. Cleared once it connects. */
  error?: string
  createdAt: number
}

/** The hub's own machine's id. */
export const LOCAL_MACHINE = 'local'

export interface SessionSummary {
  id: string
  title: string
  cwd?: string
  /** The git root its folder is in (the folder itself outside a repo), which its panels are kept by; absent until its machine has said. */
  root?: string
  /** The machine it runs on. */
  machine?: string
  lastModified: number
  running: boolean
  /** Hidden from the sidebar's main list. Archiving never deletes the transcript. */
  archived: boolean
  /** Its directory no longer exists, e.g. a removed worktree. */
  gone?: boolean
  /** A review chat: it guides you through its checkout's changes, and its page shows them. */
  review?: boolean
  /** A side chat (/btw): the chat it's under, shown in a panel beside that rather than in the sidebar. */
  sideOf?: string
  /** For a side chat, when it was forked: it knows its parent as it was then. */
  forkedAt?: number
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
  /** Its branch, or its commit's short hash when HEAD is detached. */
  branch: string
  /** Files with uncommitted changes. */
  changes: number
  /** Commits on its branch that the main checkout's HEAD doesn't have. */
  unmerged: number
  /** The main checkout's branch (or short hash, detached), which `unmerged` is counted against. */
  base: string
}

/**
 * How a branch's base was chosen: picked by hand, the base of its open pull request, or the likely one it's
 * fewest commits beyond (the main checkout's branch, the default branch, ones named like develop or release/…).
 */
export type BaseHow = 'set' | 'pr' | 'nearest'

/** For picking a branch's base by hand. */
export interface BaseChoices {
  /** Empty when HEAD is detached, which has nowhere to keep a choice. */
  branch: string
  current?: { branch: string; how: BaseHow }
  /** What was picked by hand: a branch, or '' for none. Undefined when it's worked out. */
  set?: string
  /** The likely bases, nearest first, with the commits HEAD has that each doesn't. */
  likely: { branch: string; ahead: number }[]
  /** Every other branch, local and remote, most recent first. */
  others: string[]
}

/** Work in any git checkout that hasn't landed anywhere yet: what a review looks at. */
export interface ChangesStatus {
  /** Its branch, or its commit's short hash when HEAD is detached. */
  branch: string
  /** Files with uncommitted changes. */
  changes: number
  /** What `ahead` is counted against, if it has a base: see BaseHow. */
  base?: string
  /** Commits on HEAD that `base` doesn't have. */
  ahead: number
}

/** Where a checkout stands, for the bar above a chat: what's uncommitted, and how it compares with its upstream and, in a worktree, the main checkout. */
export interface GitStatus {
  /** Empty when HEAD is detached. */
  branch: string
  /** Files with uncommitted changes, untracked ones included. */
  changes: number
  /** Uncommitted lines added and removed, new files' included. */
  added: number
  removed: number
  /** The branch's upstream, e.g. origin/spike, if it has one. */
  upstream?: string
  /** Commits on HEAD the upstream doesn't have, and the other way round. Without an upstream, `ahead` is what no remote has and `behind` is 0. */
  ahead: number
  behind: number
  /** Where a branch with no upstream would be pushed: origin, or the only remote. Absent with no remotes. */
  remote?: string
  /** The branch this one is compared with, how it was chosen, and the commits each has that the other doesn't. Absent with none. */
  base?: { branch: string; how: BaseHow; ahead: number; behind: number }
  /** When the repo last fetched, ms since epoch; absent if it never has. */
  fetchedAt?: number
}

/**
 * What a review looks at, as changes between two trees. `base`: everything not on the branch's base yet (see BaseHow),
 * committed or not. `uncommitted`: against HEAD. `commit`: one commit.
 * `since`: against a snapshot taken earlier, e.g. when the last review was sent.
 */
export type ReviewScope = { kind: 'base' } | { kind: 'uncommitted' } | { kind: 'commit'; sha: string } | { kind: 'since'; tree: string }

export interface ReviewCommit {
  sha: string
  subject: string
  author: string
  /** ms since epoch. */
  date: number
}

export interface ReviewFile {
  path: string
  /** Where a renamed file was. */
  oldPath?: string
  status: 'added' | 'modified' | 'deleted' | 'renamed'
  added: number
  removed: number
  binary: boolean
  /**
   * The file's hunks. A file with nothing to show line by line (binary, too big, a bare rename or mode change)
   * has one hunk with an empty patch, so every file can be grouped and ticked off like the rest.
   */
  hunks: ReviewHunk[]
  /** Too big to show; added and removed still count. */
  truncated?: boolean
  /** A lockfile or the like, folded unless asked for. */
  generated?: boolean
  /** The file's blob as it is now, so "viewed" is undone by a later change. Absent if it was deleted. */
  blob?: string
}

/** One hunk of a file's diff, by an id that stays the same while its lines do. */
export interface ReviewHunk {
  /** e.g. h3f2a91c0: from the file's path and the hunk's lines, not where they are. */
  id: string
  /** From its @@ line; empty when there are no lines to show. */
  patch: string
}

export interface ReviewDiff {
  branch: string
  /** What `base` compares with, e.g. develop or origin/release/2.5, and how it was chosen; absent with nothing to compare with. */
  base?: string
  baseHow?: BaseHow
  /** The checkout's top folder, which the files' paths are from. */
  root: string
  /** Commits on HEAD that aren't on the base, newest first. */
  commits: ReviewCommit[]
  /** The working tree as it was read, untracked files included: pass it back as `since` to see what changed after. */
  snapshot: string
  files: ReviewFile[]
}

/** How carefully a person should read a group: new logic where a mistake matters, ordinary changes, or mechanical ones. */
export const REVIEW_ATTENTION = ['high', 'medium', 'low'] as const
export type ReviewAttention = (typeof REVIEW_ATTENTION)[number]

/** Hunks that are one change, wherever they are, with what a reader needs to follow them. */
export interface ReviewGroup {
  /** Claude's, e.g. "settings-field"; the same id in a later guide is the same group. */
  id: string
  title: string
  attention: ReviewAttention
  /** A word or two, e.g. "new logic", "rename", "tests". */
  kind?: string
  /** Markdown: a sentence for something mechanical, plain-language background for something hard. */
  explanation: string
  hunks: string[]
}

/** A review chat's guide to its changes: every hunk in one group, groups in reading order. */
export interface ReviewGuide {
  summary: string
  groups: ReviewGroup[]
}

/** A folder new chats can start in. A git repo's is its main checkout, with its worktrees alongside. */
export interface Folder {
  path: string
  /** Added in the file browser, rather than found from chats that ran there. */
  added: boolean
  /** The latest chat in it or any of its worktrees, or when it was added, ms since epoch. */
  lastUsed: number
  /** The main checkout first, then linked worktrees, newest commit first. Absent outside a git repo. */
  checkouts?: Checkout[]
}

/** One working tree of a repo. */
export interface Checkout {
  path: string
  main: boolean
  /** As the chat header shows it, without fetching first. */
  git: GitStatus
  /** Commits on HEAD that no remote has, upstream or not. Null when the repo has no remotes. */
  unpushed: number | null
  /** The last commit, ms since epoch; 0 before the first. */
  committedAt: number
}

/** One entry in the file browser. */
export interface FileEntry {
  name: string
  dir: boolean
  /** Bytes, for files. */
  size?: number
  /** A folder with a .git in it. */
  git?: boolean
}

export interface Listing {
  path: string
  /** Null at the root. */
  parent: string | null
  entries: FileEntry[]
  /** More than were sent. */
  truncated: boolean
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
  /** `<machine>.<id>` in the browser: the machine it runs on and its short hex id there. A runner's own list has just the hex id. */
  id: string
  /** The machine it runs on. Filled in by the hub. */
  machine?: string
  /** What the program last set as its title (shells usually show the running command), else the command or shell. */
  title: string
  /** What it's called in the list: Claude's or the user's name for it, or for a shell its program and number, e.g. "fish 2". */
  name?: string
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

/** File extensions for each image type, for picking images off disk. */
export const IMAGE_EXTENSIONS: Record<(typeof IMAGE_TYPES)[number], string[]> = {
  'image/png': ['.png'],
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/gif': ['.gif'],
  'image/webp': ['.webp'],
}

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

/** What a live chat's process is doing. cwd changes when the chat moves into a worktree. */
export interface ChatStatus {
  running: boolean
  /** Claude Code is still making the worktree it was started in, so nothing's happening yet. */
  makingWorktree: boolean
  /** When Claude Code started compacting the conversation, if it's doing that now. */
  compacting?: number
  mode: PermissionMode
  /** A ModelOption value, or a model id from the transcript. Absent until the chat has run. */
  model?: string
  cwd: string
}

/** A live chat's state that only its process has, besides its messages. */
export interface LiveState extends ChatStatus {
  permissions: PendingPermission[]
  /** Output so far of Bash commands still running, by tool_use_id. */
  bashOutput: Record<string, string>
  /** Calls auto mode is still deciding whether to allow. */
  checking: string[]
  background: BackgroundTask[]
  queued: QueuedMessage[]
}

/** What a browser can ask of a chat's live process. The hub passes each on to the runner the chat is on as it is. */
export type ChatCommand =
  | { type: 'interrupt' }
  /** Withdraw a queued message if Claude Code hasn't taken it in. */
  | { type: 'unqueue'; id: string }
  /** Stop one subagent or background task, leaving the rest of the chat running. */
  | { type: 'stop_task'; taskId: string }
  /** Stop waiting on a running subagent or command and let it carry on in the background; without toolUseId, every one. */
  | { type: 'background_task'; toolUseId?: string }
  | { type: 'set_mode'; mode: PermissionMode }
  /** A chat that isn't running takes the model with its next message. */
  | { type: 'set_model'; model: string }
  | {
      type: 'permission'
      requestId: string
      decision: 'allow' | 'allow_always' | 'deny'
      message?: string
      /** Replacement tool input, e.g. AskUserQuestion answers. */
      updatedInput?: Record<string, unknown>
    }
  /** Answers picked so far in a pending AskUserQuestion; replaces what's saved. */
  | { type: 'answer_draft'; requestId: string; answers: AnswerDraft }
  /** The plan in a pending ExitPlanMode as edited so far; replaces what's saved. */
  | { type: 'plan_draft'; requestId: string; plan: string }

/** What a command answers: unqueue the message it withdrew, if Claude Code hadn't taken it in; a draft whether it's still pending. */
export type ChatCommandReply<T extends ChatCommand['type'] = ChatCommand['type']> = T extends 'unqueue'
  ? QueuedMessage | undefined
  : T extends 'answer_draft' | 'plan_draft'
    ? boolean
    : void

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
      /** Where a new chat runs; an existing one stays on its own machine. Defaults to the hub's. */
      machine?: string
      mode?: PermissionMode
      /** Used when this starts or resumes the chat's process; a running one keeps its model. */
      model?: string
      /** Start a new chat in a git worktree of cwd with this name (reused if it exists); empty lets Claude name it. */
      worktree?: string
    }
  /** With edit, a withdrawn message goes back into the composer ahead of what's typed there. */
  | { type: 'unqueue'; sessionId: string; id: string; edit?: boolean }
  | (Exclude<ChatCommand, { type: 'unqueue' }> & { sessionId: string })
  /** The composer's unsent text and attachments; each one given replaces what's saved. */
  | { type: 'draft'; sessionId: string; text?: string; attachments?: DraftAttachments }
  /** An uncaught error in the page, for the server to log. */
  | { type: 'client_error'; message: string; stack?: string; url: string }
  /** The user is looking at this chat, so it's no longer unread. */
  | { type: 'seen'; sessionId: string }
  | { type: 'term_subscribe'; id: string }
  | { type: 'term_unsubscribe'; id: string }
  | { type: 'term_input'; id: string; data: string }
  | { type: 'term_resize'; id: string; cols: number; rows: number }
  /** Where this browser reaches previews, with `{port}` for the port, e.g. `https://{port}.badger.example.com`. */
  | { type: 'preview_url'; url: string }
  /** Who this tab is, first on every connection, for analytics. */
  | ({ type: 'hello' } & ClientHello)
  /** Whether this tab is on screen and in use, and what's in it, for time tracking. */
  | ({ type: 'activity' } & ActivityBeat)
  /** Something done in the page that the hub wouldn't otherwise hear of, e.g. a notification clicked, for analytics. */
  | { type: 'ui_event'; name: string; sessionId?: string; data?: Record<string, unknown> }

/** A browser tab: its browser's id (kept in localStorage), its own (new each time the page loads), and the browser's details. */
export interface ClientHello {
  client: string
  tab: string
  info: {
    userAgent?: string
    platform?: string
    language?: string
    timeZone?: string
    screen?: { width: number; height: number; dpr: number }
    viewport?: { width: number; height: number }
    touch?: boolean
    /** Installed as an app, not in a browser tab. */
    standalone?: boolean
    /** The page's build, to compare with the hub's. */
    build?: string
  }
}

/**
 * A tab's state, sent when it changes and every few seconds while it's visible.
 * Whether that's time worked is decided later, from these.
 */
export interface ActivityBeat {
  /** What prompted it: e.g. open, visibility, focus, route, pane, views, input, tick, closed. */
  reason: string
  visible: boolean
  /** The window has focus (including a preview inside it). */
  focused: boolean
  /** How long since the last keypress, click, scroll or pointer move, by the tab's clock. Absent if there's been none. */
  idleMs?: number
  /** Inputs since the last beat, and how many of them were keypresses. */
  inputs: number
  keys: number
  /** The page's route: chat, card, board, radar, terminal or home. */
  route: string
  /** The chat on screen. */
  sessionId?: string
  /** The card on screen, on a card's page. */
  cardId?: number
  /** Panels on screen beside the chat, by view key. */
  views: string[]
  /** Where the last input or focus was: chat, sidebar, page, or a panel's view key. */
  pane?: string
}

export type ServerEvent =
  /** Everything about a chat, for a viewer starting on it. A chat with no live process has the live state of an idle one. */
  | (Omit<LiveState, 'cwd'> & {
      type: 'snapshot'
      sessionId: string
      messages: WireMessage[]
      /** Absent for a chat that hasn't started. */
      cwd?: string
      /** The machine it runs on; absent for a chat that hasn't started. While it's offline the chat is read-only. */
      machine?: string
      /** Its folder is gone or can't be opened, e.g. a worktree removed after merging, so it can't run. */
      gone?: boolean
      /** Unsent composer text, in the same message as the transcript so they arrive together. */
      draft: string
      draftAttachments: DraftAttachments
      /** Chats this one started from a tool call and waited on, by that call's tool_use_id. */
      children: Record<string, string>
    })
  | { type: 'message'; sessionId: string; message: WireMessage }
  /** Another viewer changed the chat's unsent text or attachments. */
  | { type: 'draft'; sessionId: string; text?: string; attachments?: DraftAttachments }
  /** Live output from a running Bash command; the tool_result still carries the final output. */
  | { type: 'bash_output'; sessionId: string; toolUseId: string; chunk: string }
  /** The calls auto mode is still deciding whether to allow; replaces the previous set. */
  | { type: 'checking'; sessionId: string; toolUseIds: string[] }
  | (ChatStatus & { type: 'status'; sessionId: string })
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
  /** Another viewer edited the plan in a pending ExitPlanMode. */
  | { type: 'plan_draft'; sessionId: string; requestId: string; plan: string }
  | { type: 'permission_resolved'; sessionId: string; requestId: string }
  /** The chat started a child chat from a tool call; it's shown inside that call. */
  | { type: 'child_started'; sessionId: string; toolUseId: string; childId: string }
  | { type: 'sessions_changed' }
  /** Every chat that needs the user, by id; sent on connect and whenever it changes. Children count as their parent. */
  | { type: 'attention'; chats: Record<string, AttentionState> }
  | { type: 'cards_changed' }
  /** Every machine; sent on connect and whenever one connects, disconnects or changes. */
  | { type: 'machines'; machines: Machine[] }
  /** Every terminal; sent on connect and whenever any of them changes. */
  | { type: 'terminals'; terminals: TerminalInfo[] }
  /** The terminal's screen and scrollback as escape sequences; replaces whatever the viewer had. */
  | { type: 'term_snapshot'; id: string; data: string }
  | { type: 'term_output'; id: string; data: string }
  /**
   * Claude asked to show a port's preview in the workspace's panels. A port
   * on a machine other than the hub's opens at plain localhost, so only a
   * browser on that machine shows it.
   */
  | { type: 'open_preview'; root: string; machine?: string; port: number; name?: string; path?: string }
  | { type: 'error'; sessionId?: string; error: string }
