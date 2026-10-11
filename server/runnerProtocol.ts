import type {
  AccountUsage,
  AnswerDraft,
  BackgroundTask,
  Card,
  CardStatus,
  ContextUsage,
  ImageAttachment,
  ModelOption,
  PendingPermission,
  PermissionMode,
  ServerEvent,
  TerminalInfo,
  WireMessage,
  WorktreeStatus,
} from '../shared/protocol.ts'
import type { Actor, CardPatch } from './db.ts'
import type { Later } from './peer.ts'
import type { CreateSpec } from './ptyProtocol.ts'

/**
 * Between the hub and its runners. The hub has the database, the UI and the
 * browsers; a runner has Claude Code processes, terminals and the files they
 * work on. The hub's own runner talks this over an in-memory link, remote
 * ones (`badger remote`) over a WebSocket they open to the hub's `/runner`.
 *
 * Runners and the hub are updated separately, so bump this when either side
 * would misread the other; the hub turns away runners on another version.
 */
export const RUNNER_PROTOCOL = 1

/** Header a runner sends its protocol version in, so a mismatch is caught before the upgrade. */
export const PROTOCOL_HEADER = 'x-badger-protocol'

/** What a runner says about itself once connected. */
export interface RunnerHello {
  protocol: number
  hostname: string
  /** Where new chats start on it by default. */
  workspaceDir: string
  /** Where its folderless chats run. */
  scratchDir: string
}

/** A live Claude Code process, as the hub needs to know about it between events. */
export interface LiveInfo {
  id: string
  cwd: string
  /** Taking a turn, or waiting on background work it started. */
  running: boolean
  /** A permission prompt or question is waiting on the user. */
  waiting: boolean
}

/** A live chat's state that only its process has: its messages since it started, prompts, running Bash output. */
export interface LiveSnapshot {
  messages: WireMessage[]
  running: boolean
  mode: PermissionMode
  model?: string
  cwd: string
  permissions: PendingPermission[]
  bashOutput: Record<string, string>
  background: BackgroundTask[]
}

export interface OpenOptions {
  cwd?: string
  mode?: PermissionMode
  model?: string
  worktree?: string
}

/** Runner to hub, unasked. */
export type RunnerEvent =
  /** Every live chat; sent whenever one starts, closes or changes state. */
  | { type: 'live'; sessions: LiveInfo[] }
  /** Anything a live chat emits, for its viewers. */
  | { type: 'session'; event: ServerEvent }
  | { type: 'turn_end'; sessionId: string }
  /** Every terminal, with local ids. */
  | { type: 'terminals'; terminals: TerminalInfo[] }
  | { type: 'term_output'; id: string; data: string }

/** Hub to runner, unasked. Keystrokes don't wait for an answer. */
export type HubEvent = { type: 'term_input'; id: string; data: string } | { type: 'term_resize'; id: string; cols: number; rows: number }

/** Methods a runner serves to the hub. */
export interface RunnerApi {
  /** Starts or resumes the chat if it isn't live, then sends it a message. */
  send(sessionId: string, opts: OpenOptions, text: string, pastes: string[], images: ImageAttachment[]): Promise<void>
  interrupt(sessionId: string): Promise<void>
  stopTask(sessionId: string, taskId: string): Promise<void>
  backgroundTask(sessionId: string, toolUseId?: string): Promise<void>
  setMode(sessionId: string, mode: PermissionMode): Promise<void>
  setModel(sessionId: string, model: string): Promise<void>
  resolvePermission(
    sessionId: string,
    requestId: string,
    decision: 'allow' | 'allow_always' | 'deny',
    message?: string,
    updatedInput?: Record<string, unknown>,
  ): void
  /** False if the question is no longer pending. */
  draftAnswers(sessionId: string, requestId: string, answers: AnswerDraft): boolean
  /** Null when the chat has no live process. Settled in order with the chat's events. */
  liveSnapshot(sessionId: string): Later<LiveSnapshot | null>
  contextUsage(sessionId: string): Promise<ContextUsage | undefined>
  accountUsage(): Promise<AccountUsage>
  models(): Promise<ModelOption[]>
  /** The title goes in the transcript, where the CLI's /resume sees it too. */
  rename(sessionId: string, title: string): Promise<void>
  /** Which of these folders Claude Code can't run in. */
  inaccessible(dirs: string[]): string[]
  workspaceRoot(cwd: string): string
  worktreeStatus(path: string): Promise<WorktreeStatus>
  /** Refused while a chat is working in it or it has terminals. */
  removeWorktree(path: string): Promise<void>
  termCreate(spec: CreateSpec): Promise<TerminalInfo>
  termRestart(id: string): Promise<TerminalInfo>
  termRemove(id: string): Promise<void>
  /** The screen as escape sequences, settled in order with the terminal's output. */
  termSnapshot(id: string): Later<string | undefined>
}

export const RUNNER_METHODS = [
  'send',
  'interrupt',
  'stopTask',
  'backgroundTask',
  'setMode',
  'setModel',
  'resolvePermission',
  'draftAnswers',
  'liveSnapshot',
  'contextUsage',
  'accountUsage',
  'models',
  'rename',
  'inaccessible',
  'workspaceRoot',
  'worktreeStatus',
  'removeWorktree',
  'termCreate',
  'termRestart',
  'termRemove',
  'termSnapshot',
] as const satisfies readonly (keyof RunnerApi)[]

/** A chat as the board tools describe it. */
export interface ChatInfo {
  id: string
  title?: string
  cwd?: string
  machine?: string
  machineName?: string
}

/** The board, as Claude's tools use it. The hub has it; runners reach it over their link. */
export interface Board {
  cards(): Card[]
  card(id: number): Card | undefined
  createCard(input: { title: string; description?: string; status?: CardStatus; parentId?: number | null }, actor: Actor): Card
  updateCard(id: number, patch: CardPatch, actor: Actor): Card | undefined
  deleteCard(id: number, actor: Actor): boolean
  linkSession(cardId: number, sessionId: string, actor: Actor): void
  setArchived(sessionId: string, archived: boolean, actor: Actor): boolean
  archivedIds(): string[]
  /** The chat's card for its next turn, or undefined if Claude has already seen this state. */
  cardContext(sessionId: string): string | undefined
  /** Claude has just read or written this card, so it needn't be told about it next turn. */
  markSeen(sessionId: string, cardId: number): void
  chatInfo(ids: string[]): Promise<ChatInfo[]>
}

/** One file of a chat's transcript: the main one, or a subagent's (`subagents/agent-<id>`). */
export interface TranscriptFile {
  sessionId: string
  /** '' for the main transcript. */
  subpath: string
}

/** How much of a transcript file the hub has. Always whole lines. */
export interface TranscriptState extends TranscriptFile {
  lines: number
  bytes: number
}

/** New lines of a transcript file, continuing from what the hub has. */
export interface TranscriptLines extends TranscriptFile {
  /** Claude Code's project folder it's in (its sanitised cwd). */
  project: string
  /** Where these lines start; must match what the hub has, unless `reset`. */
  fromLine: number
  fromBytes: number
  lines: string[]
  /** Size of the file up to the end of these lines. */
  bytes: number
  /** The file's modification time, ms. */
  mtime: number
  /** A subagent's .meta.json, when it changed. */
  meta?: Record<string, unknown>
  /** The file shrank, so it was rewritten: replace what the hub has. */
  reset?: boolean
}

/** Methods the hub serves to a runner. */
export interface HubApi extends Board {
  hello(hello: RunnerHello): { id: string; name: string }
  addChild(child: { sessionId: string; parentId: string; toolUseId: string; kind: string }): void
  /** What the hub has of these files; missing ones have none. */
  transcriptState(files: TranscriptFile[]): TranscriptState[]
  /** Appends lines. Returns what the hub has afterwards: a mismatch means start again from there. `ignored` if the chat belongs to another machine. */
  transcriptLines(batch: TranscriptLines): TranscriptState & { ignored?: boolean }
}

export const HUB_METHODS = [
  'cards',
  'card',
  'createCard',
  'updateCard',
  'deleteCard',
  'linkSession',
  'setArchived',
  'archivedIds',
  'cardContext',
  'markSeen',
  'chatInfo',
  'hello',
  'addChild',
  'transcriptState',
  'transcriptLines',
] as const satisfies readonly (keyof HubApi)[]

// Every method listed, so none is unreachable by accident.
true satisfies Exclude<keyof RunnerApi, (typeof RUNNER_METHODS)[number]> extends never ? true : false
true satisfies Exclude<keyof HubApi, (typeof HUB_METHODS)[number]> extends never ? true : false
