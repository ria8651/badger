import { z, type ZodType } from 'zod'
import type {
  AccountUsage,
  AnswerDraft,
  BackgroundTask,
  Card,
  ChangesStatus,
  ContextUsage,
  Folder,
  ImageAttachment,
  Listing,
  ModelOption,
  PendingPermission,
  PermissionMode,
  QueuedMessage,
  ServerEvent,
  TerminalInfo,
  WireMessage,
  WorktreeStatus,
} from '../shared/protocol.ts'
import type { OpResult } from './ops.ts'
import type { Later } from './peer.ts'
import type { CreateSpec } from './ptyProtocol.ts'

/**
 * Between the hub and its runners. The hub has the database, the UI and the
 * browsers; a runner has Claude Code processes, terminals and the files they
 * work on. The hub's own runner talks this over an in-memory link, remote
 * ones (`pnpm remote`) over a WebSocket they open to the hub's `/runner`.
 *
 * Runners and the hub are updated separately, so bump this when either side
 * would misread the other; the hub turns away runners on another version.
 */
export const RUNNER_PROTOCOL = 3

/** Header a runner sends its protocol version in, so a mismatch is caught before the upgrade. */
export const PROTOCOL_HEADER = 'x-badger-protocol'

/** The largest frame either side takes. A transcript line too big to fit is sent as a blank one. */
export const RUNNER_MAX_FRAME = 64 * 1024 * 1024

/** Chat ids are UUIDs; anything else from a runner is refused. */
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export const isUuid = (id: unknown): id is string => typeof id === 'string' && UUID.test(id)

/** What a runner says about itself once connected. */
export interface RunnerHello {
  protocol: number
  hostname: string
  /** Node's process.platform, e.g. darwin or linux. */
  platform: string
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
  makingWorktree: boolean
  mode: PermissionMode
  model?: string
  cwd: string
  permissions: PendingPermission[]
  bashOutput: Record<string, string>
  background: BackgroundTask[]
  queued: QueuedMessage[]
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
  /** A turn ended. `queued`: Claude Code holds messages that start the next one, so it isn't really over. */
  | { type: 'turn_end'; sessionId: string; queued: boolean }
  /** Every terminal, with local ids. */
  | { type: 'terminals'; terminals: TerminalInfo[] }
  | { type: 'term_output'; id: string; data: string }

/** Hub to runner, unasked. Keystrokes don't wait for an answer. */
export type HubEvent = { type: 'term_input'; id: string; data: string } | { type: 'term_resize'; id: string; cols: number; rows: number }

/** A file the browser asked for, e.g. an image to attach. Only images keep their type. */
export interface FileData {
  type?: string
  /** Base64. */
  data: string
}

/** Methods a runner serves to the hub. */
export interface RunnerApi {
  /** Starts or resumes the chat if it isn't live, then sends it a message. */
  send(sessionId: string, opts: OpenOptions, text: string, pastes: string[], images: ImageAttachment[]): Promise<void>
  /** Undefined if Claude Code had already taken it in. */
  unqueue(sessionId: string, id: string): Promise<QueuedMessage | undefined>
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
  /** False if the plan is no longer pending. */
  draftPlan(sessionId: string, requestId: string, plan: string): boolean
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
  /** Undefined outside a git repo. */
  changesStatus(path: string): Promise<ChangesStatus | undefined>
  /** Refused while a chat is working in it or it has terminals. */
  removeWorktree(path: string): Promise<void>
  /** The folders new chats can start in: these, from where its chats ran and what was added by hand, less the hidden ones. */
  listFolders(used: [string, number][], added: [string, number][], hidden: string[]): Promise<Folder[]>
  folderSize(path: string): Promise<number>
  listDir(path: string | undefined, hidden: boolean): Promise<Listing>
  makeDir(path: string): Promise<string>
  readFile(path: string): Promise<FileData>
  termCreate(spec: CreateSpec): Promise<TerminalInfo>
  termRestart(id: string): Promise<TerminalInfo>
  termRemove(id: string): Promise<void>
  /** The screen as escape sequences, settled in order with the terminal's output. */
  termSnapshot(id: string): Later<string | undefined>
}

export const RUNNER_METHODS = [
  'send',
  'unqueue',
  'interrupt',
  'stopTask',
  'backgroundTask',
  'setMode',
  'setModel',
  'resolvePermission',
  'draftAnswers',
  'draftPlan',
  'liveSnapshot',
  'contextUsage',
  'accountUsage',
  'models',
  'rename',
  'inaccessible',
  'workspaceRoot',
  'worktreeStatus',
  'changesStatus',
  'removeWorktree',
  'listFolders',
  'folderSize',
  'listDir',
  'makeDir',
  'readFile',
  'termCreate',
  'termRestart',
  'termRemove',
  'termSnapshot',
] as const satisfies readonly (keyof RunnerApi)[]

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

/** A card and its chats, as merging and reviewing need them. */
export type ChatCard = Card & { chats: { id: string; cwd?: string; machine?: string; archived: boolean }[] }

/** Who the hub says a runner is, and the chats it has put on that machine. */
export interface RunnerWelcome {
  id: string
  name: string
  /** The hub's own machine, whose previews the hub can reach and drive. */
  local: boolean
  /** Every chat on this machine, children included. The runner copies these transcripts and no others. */
  chats: string[]
}

/**
 * Methods the hub serves to a runner. The hub decides which machine every chat
 * is on, and refuses anything a runner sends about a chat that isn't on its
 * own machine.
 */
export interface HubApi {
  hello(hello: RunnerHello): RunnerWelcome
  /**
   * Runs one of the hub's operations (the board, and the bridge into the hub's
   * previews) for a chat on this machine: its tools and scripts call these
   * here. Failures the caller should read come back as BadRequests.
   */
  runOp(chat: string, script: string, input: unknown): Promise<OpResult>
  /** The card a chat is on, with where its chats are, for merging and reviewing. Unlike get_card, Claude isn't shown it, so it doesn't count as seen. */
  chatCard(chat: string): Promise<ChatCard | undefined>
  /** The chat's card for its next turn, or undefined if Claude has already seen this state. A peek doesn't count it as seen. */
  cardContext(chat: string, peek: boolean): string | undefined
  /** Shows a port's preview in the browsers on that workspace. Returns how many tabs are connected, and the preview's URL if it has one. */
  openPreview(chat: string, preview: { root: string; port: number; name?: string; path: string }): { tabs: number; url?: string }
  /** Puts a new chat on this machine as a child of one already here. Returns its id. */
  startChild(child: { parentId: string; toolUseId: string; kind: string }): string
  /** What the hub has of these files; missing ones have none. */
  transcriptState(files: TranscriptFile[]): TranscriptState[]
  /** Appends lines. Returns what the hub has afterwards: a mismatch means start again from there. */
  transcriptLines(batch: TranscriptLines): TranscriptState
}

// ── What the hub takes from runners, checked before anything else sees it ──
// A runner may be on a laptop that's been lost, so the hub doesn't trust it:
// every call's arguments and every event must match these. Which chats it may
// act for is checked after, against the hub's own records.

const chatId = z.string().regex(UUID)
const text = (max: number) => z.string().max(max)
const count = z.number().int().nonnegative()
const transcriptFile = z.object({ sessionId: chatId, subpath: z.string().regex(/^[\w./-]{0,200}$/) })

/** Each hub method's arguments. A method that isn't here can't be called. */
export const HUB_ARGS = {
  hello: z.tuple([
    z.object({ protocol: z.number(), hostname: text(255), platform: text(50), workspaceDir: text(4096), scratchDir: text(4096) }),
  ]),
  runOp: z.tuple([chatId, text(100), z.unknown()]),
  chatCard: z.tuple([chatId]),
  cardContext: z.tuple([chatId, z.boolean()]),
  openPreview: z.tuple([
    chatId,
    // The browser puts the path after a host, so anything but a path (`@other.host/`) would send it elsewhere.
    z.object({ root: text(4096), port: z.number().int().min(1).max(65535), name: text(200).optional(), path: text(4096).regex(/^\/(?!\/)/) }),
  ]),
  startChild: z.tuple([z.object({ parentId: chatId, toolUseId: text(200), kind: text(50) })]),
  transcriptState: z.tuple([z.array(transcriptFile).max(1000)]),
  transcriptLines: z.tuple([
    transcriptFile.extend({
      project: text(1000),
      fromLine: count,
      fromBytes: count,
      lines: z.array(z.string()),
      bytes: count,
      mtime: z.number(),
      meta: z.record(z.string(), z.unknown()).optional(),
      reset: z.boolean().optional(),
    }),
  ]),
} satisfies { [K in keyof HubApi]: ZodType<Parameters<HubApi[K]>> }

/** What a live chat emits, as its runner passes it on. The rest of ServerEvent is the hub's own to send. */
export const SESSION_EVENTS = [
  'message',
  'bash_output',
  'status',
  'queued',
  'background',
  'permission_request',
  'permission_resolved',
  'error',
  'child_started',
] as const satisfies readonly ServerEvent['type'][]

const terminalInfo = z.object({
  id: z.string().regex(/^[0-9a-f]{1,32}$/),
  title: text(1000),
  cwd: text(4096),
  root: text(4096),
  command: text(100_000).optional(),
  sessionId: chatId.optional(),
  running: z.boolean(),
  pid: z.number().int().optional(),
  ports: z.array(z.number().int()).max(100).optional(),
  exitCode: z.number().optional(),
  signal: z.number().optional(),
  createdAt: z.number(),
}) satisfies ZodType<TerminalInfo>

/** Every event a runner may send. Anything else is dropped. */
export const RUNNER_EVENT = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('live'),
    sessions: z.array(z.object({ id: chatId, cwd: text(4096), running: z.boolean(), waiting: z.boolean() })).max(10_000),
  }),
  // The rest of the event is the chat's own content (messages, prompts), passed on to its viewers as it is.
  z.object({ type: z.literal('session'), event: z.looseObject({ type: z.enum(SESSION_EVENTS), sessionId: chatId }) }),
  z.object({ type: z.literal('turn_end'), sessionId: chatId, queued: z.boolean() }),
  z.object({ type: z.literal('terminals'), terminals: z.array(terminalInfo).max(1000) }),
  z.object({ type: z.literal('term_output'), id: z.string().max(32), data: z.string() }),
])

// Every runner method listed, so none is unreachable by accident.
true satisfies Exclude<keyof RunnerApi, (typeof RUNNER_METHODS)[number]> extends never ? true : false
