import { mkdir, readFile, stat } from 'node:fs/promises'
import { hostname } from 'node:os'
import { extname, isAbsolute, resolve } from 'node:path'
import { renameSession } from '@anthropic-ai/claude-agent-sdk'
import { IMAGE_EXTENSIONS, IMAGE_TYPES, type AnswerDraft, type ImageAttachment, type PermissionMode } from '../shared/protocol.ts'
import { BOARD_INSTRUCTIONS, BOARD_SERVER, boardOps } from './boardTools.ts'
import { Children } from './children.ts'
import { BadRequest } from './db.ts'
import { folderSize, forgetSize, listDir, listFolders } from './folders.ts'
import { MERGE_TOOL, mergeTool } from './merge.ts'
import { OpError, forwarded, mcpServer, toolName, type Op } from './ops.ts'
import { Later, Peer, type Link, type Remote } from './peer.ts'
import { bridgeOps, openPreviewOp, previewInstructions } from './previewTools.ts'
import type { CreateSpec } from './ptyProtocol.ts'
import { REVIEW_TOOL, reviewTool } from './review.ts'
import {
  RUNNER_METHODS,
  RUNNER_PROTOCOL,
  type FileData,
  type HubApi,
  type HubEvent,
  type LiveInfo,
  type LiveSnapshot,
  type OpenOptions,
  type RunnerApi,
  type RunnerEvent,
  type RunnerWelcome,
} from './runnerProtocol.ts'
import { scriptOp } from './scripts.ts'
import { SessionManager, listModels } from './session.ts'
import { TranscriptSync } from './sync.ts'
import { TERMINAL_INSTRUCTIONS, TERMINAL_SERVER, terminalOps } from './terminalTools.ts'
import { Terminals } from './terminals.ts'
import { ContextReader, readAccount } from './usage.ts'
import { changesStatus, excludeWorktrees, inaccessible, removeWorktree, workspaceRoot, worktreeStatus } from './workspace.ts'

// Merging only starts a chat in the main checkout, and that chat asks for anything risky itself.
const MERGE_TOOL_NAME = `mcp__${BOARD_SERVER}__${MERGE_TOOL}`
// Reviewing only starts a chat that's told to report, not change anything.
const REVIEW_TOOL_NAME = `mcp__${BOARD_SERVER}__${REVIEW_TOOL}`
/** The biggest file the browser can fetch from a runner, e.g. an image to attach. */
const MAX_FILE_BYTES = 20 * 1024 * 1024

export interface RunnerOptions {
  /** Where new chats start by default. */
  workspaceDir: string
  /** Where folderless chats run. */
  scratchDir: string
  /** For the PTY host's socket and log. */
  dataDir: string
  /** Environment for terminals: the user's shell, minus what pnpm and Badger add. */
  env: NodeJS.ProcessEnv
}

/**
 * Everything that has to happen on the machine with the files: Claude Code
 * processes, their tools, terminals, git. It serves the hub over a link,
 * which drops and comes back for a remote runner; Claude keeps working
 * meanwhile, and the transcripts catch up when the hub is back.
 */
export class Runner implements RunnerApi {
  readonly manager: SessionManager
  readonly terminals: Terminals
  private peer: Peer<HubApi> | null = null
  private machine = ''
  /** The hub's own machine: the hub's proxy reaches its ports, so Claude can drive its previews. */
  private local = false
  /** The chats the hub has put on this machine. Only these are copied to it. */
  private chats = new Set<string>()
  private children: Children
  private sync: TranscriptSync
  private contexts: ContextReader
  private roots = new Map<string, string>()
  /** The hub, as whichever link is up now; calls fail while none is. */
  private readonly hub: Remote<HubApi>
  private opList?: Op[]

  constructor(private opts: RunnerOptions) {
    this.hub = new Proxy({} as Remote<HubApi>, {
      get: (_, method) =>
        typeof method === 'string'
          ? (...args: unknown[]) => (this.peer ? this.peer.call(method, args) : Promise.reject(new Error('Not connected to the Badger hub')))
          : undefined,
    })
    this.terminals = new Terminals(opts.dataDir, opts.env)
    this.manager = new SessionManager(
      () => this.sendLive(),
      (sessionId, cwd) => {
        const ops = this.ops()
        const ctx = { sessionId, cwd }
        return {
          mcpServers: {
            [BOARD_SERVER]: mcpServer(BOARD_SERVER, BOARD_INSTRUCTIONS, ops, ctx, [
              // Only as tools: each shows inside its own call.
              mergeTool(
                {
                  machine: () => this.machine,
                  cardOf: (id) => this.hub.chatCard(id),
                  finish: async (id, card) => {
                    await (card ? this.hubOp(id, 'cards.update', { id: card.id, status: 'done' }) : this.hubOp(id, 'chats.archive', {}))
                  },
                  manager: this.manager,
                  terminals: this.terminals,
                  children: this.children,
                },
                sessionId,
                cwd,
                MERGE_TOOL_NAME,
              ),
              reviewTool({ cardOf: (id) => this.hub.chatCard(id), manager: this.manager, children: this.children }, sessionId, cwd, REVIEW_TOOL_NAME),
            ]),
            [TERMINAL_SERVER]: mcpServer(TERMINAL_SERVER, [...TERMINAL_INSTRUCTIONS, ...previewInstructions(this.local)].join('\n'), ops, ctx),
          },
          allowedTools: [...ops.filter((o) => o.autoAllow).map(toolName), MERGE_TOOL_NAME, REVIEW_TOOL_NAME],
          turnContext: (peek) => this.hub.cardContext(sessionId, peek),
        }
      },
      (sessionId) => {
        this.emit({ type: 'turn_end', sessionId, queued: !!this.manager.get(sessionId)?.hasQueued })
        this.sync.touch(sessionId)
      },
      (session) =>
        session.subscribe((event) => {
          // The hub works out who's waiting from the live list, so it has to be current before the prompt arrives.
          if (event.type === 'permission_request' || event.type === 'permission_resolved') this.sendLive()
          this.emit({ type: 'session', event })
          if (event.type === 'message' && event.message.type !== 'stream_event') this.sync.touch(session.id)
        }),
    )
    this.children = new Children(this.manager, async (child) => {
      const id = await this.hub.startChild(child)
      this.chats.add(id)
      return id
    })
    this.contexts = new ContextReader(this.manager)
    this.sync = new TranscriptSync(
      this.hub,
      () => this.manager.all().map((s) => s.id),
      () => this.chats,
    )
    this.terminals.on((e) => {
      if (e.type === 'terminals') this.emit({ type: 'terminals', terminals: e.terminals })
      else this.emit({ type: 'term_output', id: e.id, data: e.data })
    })
  }

  /** Serves the hub over this link until it closes. Resolves once the hub has said who this machine is and which chats are on it. */
  async connect(link: Link): Promise<RunnerWelcome> {
    const peer = new Peer<HubApi>(
      link,
      this,
      RUNNER_METHODS,
      (event: HubEvent) => {
        if (event.type === 'term_input') this.terminals.input(event.id, event.data)
        else if (event.type === 'term_resize') this.terminals.resize(event.id, event.cols, event.rows)
      },
      () => {
        if (this.peer !== peer) return
        this.peer = null
        this.sync.stop()
      },
    )
    this.peer = peer
    const me = await peer.remote.hello({
      protocol: RUNNER_PROTOCOL,
      hostname: hostname(),
      platform: process.platform,
      workspaceDir: this.opts.workspaceDir,
      scratchDir: this.opts.scratchDir,
    })
    this.machine = me.id
    if (me.local !== this.local) this.opList = undefined
    this.local = me.local
    // Added to, not replaced: a chat the hub sent here while hello's answer was on its way is already in it. Chats never move off.
    for (const id of me.chats) this.chats.add(id)
    this.sendLive()
    // Before the PTY host has said hello the list is unknown, not empty; it's sent once it arrives.
    if (this.terminals.known) this.emit({ type: 'terminals', terminals: this.terminals.terminals })
    this.terminals.connect().catch((err) => console.error(err.message))
    this.sync.start()
    return me
  }

  closeAll(): void {
    this.manager.closeAll()
  }

  /**
   * Every op a chat here has. The board's run on the hub, which has it, and so
   * do the preview bridge's, for the hub's own machine only: its proxy is
   * what puts the bridge in the page. The rest run here.
   */
  private ops(): Op[] {
    if (this.opList) return this.opList
    const onHub = (o: Op, args: unknown, ctx: { sessionId: string }) => this.hub.runOp(ctx.sessionId, o.script, args).catch(asOpError)
    const ops: Op[] = [
      ...forwarded(boardOps, onHub),
      ...(this.local ? forwarded(bridgeOps, onHub) : []),
      ...terminalOps(this.terminals),
      openPreviewOp({ open: (sessionId, preview) => this.hub.openPreview(sessionId, preview) }),
    ]
    ops.push(scriptOp(BOARD_SERVER, () => ops))
    return (this.opList = ops)
  }

  /** One of the hub's ops, as a chat here; its value. */
  private async hubOp(sessionId: string, script: string, input: unknown): Promise<unknown> {
    return (await this.hub.runOp(sessionId, script, input).catch(asOpError)).value
  }

  private emit(event: RunnerEvent): void {
    this.peer?.emit(event)
  }

  private sendLive(): void {
    const sessions: LiveInfo[] = this.manager.all().map((s) => ({ id: s.id, cwd: s.cwd, running: this.manager.isRunning(s.id), waiting: s.waiting }))
    this.emit({ type: 'live', sessions })
  }

  // ── What the hub asks of it ──

  async send(sessionId: string, opts: OpenOptions, text: string, pastes: string[], images: ImageAttachment[]): Promise<void> {
    // The hub only sends chats it has put on this machine.
    this.chats.add(sessionId)
    const isNew = !this.manager.get(sessionId)
    if (isNew && opts.worktree !== undefined && opts.cwd) {
      await excludeWorktrees(opts.cwd).catch(() => {
        throw new BadRequest(`${opts.cwd} isn't a git repository, so it can't have worktrees`)
      })
    }
    const session = await this.manager.open(sessionId, opts).catch(badRequest)
    if (!session.send(text, pastes, images)) throw new Error('Session is closed; try again')
  }

  async unqueue(sessionId: string, id: string) {
    return this.manager.get(sessionId)?.unqueue(id)
  }

  async interrupt(sessionId: string): Promise<void> {
    await this.manager.get(sessionId)?.interrupt()
  }

  async stopTask(sessionId: string, taskId: string): Promise<void> {
    await this.manager.get(sessionId)?.stopTask(taskId)
  }

  async backgroundTask(sessionId: string, toolUseId?: string): Promise<void> {
    await this.manager.get(sessionId)?.backgroundTask(toolUseId)
  }

  async setMode(sessionId: string, mode: PermissionMode): Promise<void> {
    await this.manager.get(sessionId)?.setMode(mode)
  }

  async setModel(sessionId: string, model: string): Promise<void> {
    // A chat that isn't running takes the model with its next message.
    await this.manager.get(sessionId)?.setModel(model)
  }

  resolvePermission(
    sessionId: string,
    requestId: string,
    decision: 'allow' | 'allow_always' | 'deny',
    message?: string,
    updatedInput?: Record<string, unknown>,
  ): void {
    this.manager.get(sessionId)?.resolvePermission(requestId, decision, message, updatedInput)
  }

  draftAnswers(sessionId: string, requestId: string, answers: AnswerDraft): boolean {
    return !!this.manager.get(sessionId)?.draftAnswers(requestId, answers)
  }

  draftPlan(sessionId: string, requestId: string, plan: string): boolean {
    return !!this.manager.get(sessionId)?.draftPlan(requestId, plan)
  }

  liveSnapshot(sessionId: string): Later<LiveSnapshot | null> {
    return new Later((settle) => settle(null, this.manager.get(sessionId)?.snapshot() ?? null))
  }

  contextUsage(sessionId: string) {
    return this.contexts.context(sessionId)
  }

  accountUsage() {
    return readAccount(this.manager)
  }

  models() {
    return listModels()
  }

  async rename(sessionId: string, title: string): Promise<void> {
    await renameSession(sessionId, title).catch(badRequest)
    this.sync.touch(sessionId)
  }

  inaccessible(dirs: string[]): string[] {
    return dirs.filter(inaccessible)
  }

  workspaceRoot(cwd: string): string {
    if (!this.roots.has(cwd)) this.roots.set(cwd, workspaceRoot(cwd))
    return this.roots.get(cwd)!
  }

  worktreeStatus(path: string) {
    return worktreeStatus(path).catch(badRequest)
  }

  changesStatus(path: string) {
    return changesStatus(path).catch(badRequest)
  }

  async removeWorktree(dir: string): Promise<void> {
    if (this.manager.in(dir).some((s) => s.running)) throw new BadRequest('A chat is still working in this worktree')
    if (this.terminals.terminals.some((t) => t.root === dir)) throw new BadRequest('Close its terminals first')
    for (const s of this.manager.in(dir)) s.close()
    await removeWorktree(dir).catch(badRequest)
    forgetSize(dir)
  }

  listFolders(used: [string, number][], added: [string, number][], hidden: string[]) {
    const all = new Map(used)
    // So a machine with no chats yet still offers somewhere to start.
    if (!all.has(this.opts.workspaceDir)) all.set(this.opts.workspaceDir, 0)
    all.delete(this.opts.scratchDir)
    return listFolders(all, new Map(added), new Set(hidden))
  }

  folderSize(path: string) {
    return folderSize(absolute(path))
  }

  listDir(path: string | undefined, hidden: boolean) {
    return listDir(path ? absolute(path) : this.home(), hidden).catch(badRequest)
  }

  async makeDir(path: string): Promise<string> {
    const dir = absolute(path)
    await mkdir(dir).catch(badRequest)
    return dir
  }

  async readFile(path: string): Promise<FileData> {
    const file = absolute(path)
    const info = await stat(file).catch(badRequest)
    if (info.isDirectory()) throw new BadRequest('path must be a file')
    if (info.size > MAX_FILE_BYTES) throw new BadRequest(`${file} is too big to open here`)
    const type = IMAGE_TYPES.find((t) => IMAGE_EXTENSIONS[t].includes(extname(file).toLowerCase()))
    return { type, data: (await readFile(file)).toString('base64') }
  }

  termCreate(spec: CreateSpec) {
    return this.terminals.create(spec).catch(badRequest)
  }

  termRestart(id: string) {
    return this.terminals.restart(id)
  }

  termRemove(id: string) {
    return this.terminals.remove(id)
  }

  termSnapshot(id: string): Later<string | undefined> {
    return new Later((settle) => this.terminals.snapshot(id, (data) => settle(null, data)))
  }

  /** Where the file browser starts: the user's home, which the workspace is usually in. */
  private home(): string {
    return process.env.HOME || this.opts.workspaceDir
  }
}

const badRequest = (err: Error): never => {
  throw new BadRequest(err.message)
}

/** A failure the hub says the caller should read, as an op's own. */
const asOpError = (err: unknown): never => {
  throw err instanceof BadRequest ? new OpError(err.message) : err
}

function absolute(path: string): string {
  if (!isAbsolute(path)) throw new BadRequest('path must be an absolute path')
  return resolve(path)
}
