import { hostname } from 'node:os'
import { renameSession } from '@anthropic-ai/claude-agent-sdk'
import type { AnswerDraft, ImageAttachment, PermissionMode } from '../shared/protocol.ts'
import { BOARD_AUTO_ALLOWED, BOARD_SERVER, boardServer } from './boardTools.ts'
import { Children } from './children.ts'
import { BadRequest } from './db.ts'
import { MERGE_TOOL, mergeTool } from './merge.ts'
import { Later, Peer, type Link, type Remote } from './peer.ts'
import {
  RUNNER_METHODS,
  RUNNER_PROTOCOL,
  type HubApi,
  type HubEvent,
  type LiveInfo,
  type LiveSnapshot,
  type OpenOptions,
  type RunnerApi,
  type RunnerEvent,
  type RunnerWelcome,
} from './runnerProtocol.ts'
import { SessionManager, listModels } from './session.ts'
import { TranscriptSync } from './sync.ts'
import { TERMINAL_AUTO_ALLOWED, TERMINAL_SERVER, terminalServer } from './terminalTools.ts'
import { Terminals } from './terminals.ts'
import type { CreateSpec } from './ptyProtocol.ts'
import { ContextReader, readAccount } from './usage.ts'
import { excludeWorktrees, inaccessible, removeWorktree, workspaceRoot, worktreeStatus } from './workspace.ts'

// Merging only starts a chat in the main checkout, and that chat asks for anything risky itself.
const MERGE_TOOL_NAME = `mcp__${BOARD_SERVER}__${MERGE_TOOL}`

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
 * processes, terminals, git. It serves the hub over a link, which drops and
 * comes back for a remote runner; Claude keeps working meanwhile, and the
 * transcripts catch up when the hub is back.
 */
export class Runner implements RunnerApi {
  readonly manager: SessionManager
  readonly terminals: Terminals
  private peer: Peer<HubApi> | null = null
  private machine = ''
  /** The chats the hub has put on this machine. Only these are copied to it. */
  private chats = new Set<string>()
  private children: Children
  private sync: TranscriptSync
  private contexts: ContextReader
  private roots = new Map<string, string>()
  /** The hub, as whichever link is up now; calls fail while none is. */
  private readonly hub: Remote<HubApi>

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
      (sessionId, cwd) => ({
        mcpServers: {
          [BOARD_SERVER]: boardServer(this.hub, sessionId, () => this.machine, [
            mergeTool(
              { board: this.hub, machine: () => this.machine, manager: this.manager, terminals: this.terminals, children: this.children },
              sessionId,
              cwd,
              MERGE_TOOL_NAME,
            ),
          ]),
          [TERMINAL_SERVER]: terminalServer(this.terminals, sessionId, cwd),
        },
        allowedTools: [...BOARD_AUTO_ALLOWED, MERGE_TOOL_NAME, ...TERMINAL_AUTO_ALLOWED],
        turnContext: () => this.hub.cardContext(sessionId),
      }),
      (sessionId) => {
        this.emit({ type: 'turn_end', sessionId })
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
      workspaceDir: this.opts.workspaceDir,
      scratchDir: this.opts.scratchDir,
    })
    this.machine = me.id
    this.chats = new Set(me.chats)
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
    const session = await this.manager.open(sessionId, opts)
    if (!session.send(text, pastes, images)) throw new Error('Session is closed; try again')
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
    await renameSession(sessionId, title).catch((err: Error) => {
      throw new BadRequest(err.message)
    })
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
    return worktreeStatus(path).catch((err: Error) => {
      throw new BadRequest(err.message)
    })
  }

  async removeWorktree(dir: string): Promise<void> {
    if (this.manager.in(dir).some((s) => s.running)) throw new BadRequest('A chat is still working in this worktree')
    if (this.terminals.terminals.some((t) => t.root === dir)) throw new BadRequest('Close its terminals first')
    for (const s of this.manager.in(dir)) s.close()
    await removeWorktree(dir).catch((err: Error) => {
      throw new BadRequest(err.message)
    })
  }

  termCreate(spec: CreateSpec) {
    return this.terminals.create(spec).catch((err: Error) => {
      throw new BadRequest(err.message)
    })
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
}
