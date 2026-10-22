import { z, type ZodType } from 'zod'
import type {
  AccountUsage,
  Card,
  ChatCommand,
  ChatCommandReply,
  ChatStatus,
  GitStatus,
  ReviewDiff,
  ReviewScope,
  ContextUsage,
  Folder,
  ImageAttachment,
  Listing,
  LiveState,
  ModelOption,
  PermissionMode,
  QueuedMessage,
  ServerEvent,
  TerminalInfo,
  WireMessage,
  WorktreeStatus,
} from '../shared/protocol.ts'
import { IMAGE_TYPES, PERMISSION_MODES } from '../shared/protocol.ts'
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
export const RUNNER_PROTOCOL = 7

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
  /** How many of its turns have ended (not counting ones queued messages carried on), since the runner started. */
  turns: number
}

/** A live chat's state that only its process has: its messages since it started, prompts, running Bash output. */
export interface LiveSnapshot extends LiveState {
  messages: WireMessage[]
}

/** The live state of a chat with no process: nothing running, waiting or queued. Its mode is the one new chats start in. */
export const IDLE: Omit<LiveState, 'cwd' | 'model'> = {
  running: false,
  makingWorktree: false,
  mode: 'auto',
  permissions: [],
  bashOutput: {},
  checking: [],
  background: [],
  queued: [],
}

/** Part of a transcript file the hub sends a runner: the chat's own (`subpath` '') or a subagent's. */
export interface ImportedFile {
  subpath: string
  lines: string[]
  /** Not the file's first part. */
  append: boolean
  /** A subagent's .meta.json. */
  meta?: Record<string, unknown>
}

export interface OpenOptions {
  cwd?: string
  mode?: PermissionMode
  model?: string
  /** Start in a new worktree of cwd with this name; empty lets Claude name it. For a new chat, or a fork that hasn't run. */
  worktree?: string
  /** A review chat, which gets the tools for guiding a review. */
  review?: boolean
}

/** Runner to hub, unasked. */
export type RunnerEvent =
  /** Every live chat; sent whenever one starts, closes or changes state. */
  | { type: 'live'; sessions: LiveInfo[] }
  /** Anything a live chat emits, for its viewers. */
  | { type: 'session'; event: ServerEvent }
  /** A turn ended. `queued`: Claude Code holds messages that start the next one, so it isn't really over. */
  | { type: 'turn_end'; sessionId: string; queued: boolean; turns: number }
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
  /** Passes a browser's command to the chat's live process; one without a process has nothing to do. */
  command(sessionId: string, command: ChatCommand): Promise<ChatCommandReply>
  /** Null when the chat has no live process. Settled in order with the chat's events. */
  liveSnapshot(sessionId: string): Later<LiveSnapshot | null>
  contextUsage(sessionId: string): Promise<ContextUsage | undefined>
  accountUsage(): Promise<AccountUsage>
  models(): Promise<ModelOption[]>
  /** The title goes in the transcript, where the CLI's /resume sees it too. */
  rename(sessionId: string, title: string): Promise<void>
  /**
   * Writes part of a forked chat's transcript here, where Claude Code keeps
   * those of chats in `cwd`, and puts the chat on this machine. A file's
   * first part makes it; the rest are appended.
   */
  importTranscript(sessionId: string, cwd: string, file: ImportedFile): Promise<void>
  /** Which of these folders Claude Code can't run in. */
  inaccessible(dirs: string[]): string[]
  workspaceRoot(cwd: string): string
  worktreeStatus(path: string): Promise<WorktreeStatus>
  /** Undefined outside a git repo. Fetches first if asked, at most once a minute. */
  gitStatus(path: string, fetch: boolean): Promise<GitStatus | undefined>
  gitPush(path: string): Promise<void>
  /** The changes a review looks at; see ReviewScope. */
  reviewDiff(path: string, scope: ReviewScope, context: number): Promise<ReviewDiff>
  /** Fast-forward only; refused while a chat is working there. */
  gitPull(path: string): Promise<void>
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
  /** No name, or a blank one, puts the default back. */
  termRename(id: string, name?: string): Promise<TerminalInfo>
  termRemove(id: string): Promise<void>
  /** The screen as escape sequences, settled in order with the terminal's output. */
  termSnapshot(id: string): Later<string | undefined>
}

export const RUNNER_METHODS = [
  'send',
  'command',
  'liveSnapshot',
  'contextUsage',
  'accountUsage',
  'models',
  'rename',
  'importTranscript',
  'inaccessible',
  'workspaceRoot',
  'worktreeStatus',
  'gitStatus',
  'gitPush',
  'reviewDiff',
  'gitPull',
  'removeWorktree',
  'listFolders',
  'folderSize',
  'listDir',
  'makeDir',
  'readFile',
  'termCreate',
  'termRestart',
  'termRename',
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
  /** There's more of the file already written, coming next. */
  more?: boolean
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
  /** The chat's card for its next turn, or undefined if Claude has already seen this state. Asking doesn't count it as seen. */
  cardContext(chat: string): string | undefined
  /** Claude has been given this card context. */
  contextSeen(chat: string, text: string): void
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
  cardContext: z.tuple([chatId]),
  contextSeen: z.tuple([chatId, text(1_000_000)]),
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
      more: z.boolean().optional(),
    }),
  ]),
} satisfies { [K in keyof HubApi]: ZodType<Parameters<HubApi[K]>> }

/** What a live chat emits, as its runner passes it on. The rest of ServerEvent is the hub's own to send. */
export const SESSION_EVENTS = [
  'message',
  'bash_output',
  'checking',
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
  name: text(1000).optional(),
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

const liveInfo = z.object({ id: chatId, cwd: text(4096), running: z.boolean(), waiting: z.boolean(), turns: count }) satisfies ZodType<LiveInfo>

/** Every event a runner may send. Anything else is dropped. */
export const RUNNER_EVENT = z.discriminatedUnion('type', [
  z.object({ type: z.literal('live'), sessions: z.array(liveInfo).max(10_000) }),
  // The rest of the event is the chat's own content (messages, prompts), passed on to its viewers as it is.
  z.object({ type: z.literal('session'), event: z.looseObject({ type: z.enum(SESSION_EVENTS), sessionId: chatId }) }),
  z.object({ type: z.literal('turn_end'), sessionId: chatId, queued: z.boolean(), turns: count }),
  z.object({ type: z.literal('terminals'), terminals: z.array(terminalInfo).max(1000) }),
  z.object({ type: z.literal('term_output'), id: z.string().max(32), data: z.string() }),
])

export const imageAttachment = z.object({ mediaType: z.enum(IMAGE_TYPES), data: z.string() }) satisfies ZodType<ImageAttachment>

const queuedMessage = z.object({ id: z.string(), text: z.string(), pastes: z.array(z.string()), images: z.array(imageAttachment) }) satisfies ZodType<QueuedMessage>

const chatStatus = z.object({
  running: z.boolean(),
  makingWorktree: z.boolean(),
  compacting: z.number().optional(),
  mode: z.enum(PERMISSION_MODES),
  model: z.string().optional(),
  cwd: z.string(),
}) satisfies ZodType<ChatStatus>

/**
 * What the hub takes back from a runner's methods, where it does more than
 * pass it on to a browser as JSON. An answer that doesn't match fails the
 * call, as if the runner had thrown.
 */
export const RUNNER_REPLIES = {
  liveSnapshot: chatStatus
    .extend({
      // The chat's own content, passed on to its viewers as it is.
      messages: z.array(z.looseObject({ type: z.string() })),
      permissions: z.array(z.looseObject({ requestId: z.string() })),
      bashOutput: z.record(z.string(), z.string()),
      checking: z.array(z.string()),
      background: z.array(z.looseObject({})),
      queued: z.array(queuedMessage.loose()),
    })
    .loose()
    .nullable(),
  command: z.union([queuedMessage, z.boolean()]).optional(),
  inaccessible: z.array(z.string()),
  workspaceRoot: z.string(),
  makeDir: z.string(),
  folderSize: z.number(),
  // Only images keep a type: anything else served as the hub's own page could act as the user.
  readFile: z.object({ type: z.enum(IMAGE_TYPES).optional(), data: z.string() }),
  termCreate: terminalInfo,
  termRestart: terminalInfo,
  termRename: terminalInfo,
  termSnapshot: z.string().optional(),
} satisfies { [K in keyof RunnerApi]?: ZodType }

// Every runner method listed, so none is unreachable by accident.
true satisfies Exclude<keyof RunnerApi, (typeof RUNNER_METHODS)[number]> extends never ? true : false
