import { randomUUID } from 'node:crypto'
import { getSessionInfo, query, type McpServerConfig, type Query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { BackgroundTask, ChatCommand, ChatCommandReply, ChatStatus, ImageAttachment, PermissionMode, QueuedMessage, ServerEvent, WireMessage } from '../shared/protocol.ts'
import { wrapPaste } from '../shared/pastes.ts'
import { BashStreams } from './bashStream.ts'
import { readContext, readLimits } from './claudeProbe.ts'
import { message } from './errors.ts'
import { MessageQueue } from './queue.ts'
import type { LiveSnapshot } from './runnerProtocol.ts'
import { AutoChecks } from './session/checks.ts'
import { sdkOptions } from './session/options.ts'
import { Outbox, publicQueued } from './session/outbox.ts'
import { Permissions } from './session/permissions.ts'
import { inaccessible } from './workspace.ts'

/** Close an idle Claude Code process after this long; the next message resumes it. */
const IDLE_CLOSE_MS = 15 * 60 * 1000

type Listener = (event: ServerEvent) => void

/** Extra tools for one chat: MCP servers by name, and which of their tools skip the permission prompt. */
export interface SessionTools {
  mcpServers: Record<string, McpServerConfig>
  allowedTools: string[]
  /** Text to add to the conversation alongside the user's next message, if any. Asking doesn't count it as added. */
  turnContext?: () => Promise<string | undefined>
  /** The turn's context has gone in. If this is lost on the way, it goes in again next turn. */
  contextAdded?: (text: string) => void
  /** Environment for Claude Code and the commands it runs, on top of the server's. */
  env?: Record<string, string>
}

/**
 * One chat backed by a live Claude Code process. The process stays up across
 * turns (fed by a MessageQueue) and is torn down after a period of idleness.
 */
export class LiveSession {
  readonly id: string
  /** Changes when Claude moves into or out of a worktree. */
  cwd: string
  mode: PermissionMode
  /** What the chat was started with or switched to; otherwise what Claude Code reports it's using. */
  model?: string
  running = false
  /** Started with --worktree and Claude Code hasn't come up in it yet, e.g. a WorktreeCreate hook is still copying files. */
  makingWorktree: boolean
  /** When Claude Code started compacting the conversation, while it is. */
  compacting?: number
  /** Any background work is running, the subagents' own included; closing the process would kill it. */
  busy = false

  private queue = new MessageQueue()
  private agent: Query
  private listeners = new Set<Listener>()
  private permissions: Permissions
  private checks: AutoChecks
  private outbox: Outbox
  /** Non-streaming messages seen since this process started, keyed for dedupe with disk. */
  private live: WireMessage[] = []
  private idleTimer: NodeJS.Timeout | null = null
  private bash: BashStreams
  private onClose: () => void
  /** Its cwd changed or it started or finished working. */
  private onChange: () => void
  private onTurnEnd: () => void
  /** Tool calls that have started, by tool_use_id, so a tool's handler can find out which call it is. */
  private toolUses = new Map<string, string>()
  /** Until the first init: only that one says where --worktree put us. */
  private awaitingInit = true
  private afterTurnCallbacks: (() => void)[] = []
  /** Subagents' descriptions by agent id, to say which one is asking for permission. */
  private agents = new Map<string, string>()
  /** Started from the chat itself and running now. They outlive the turn that started them. */
  private background: BackgroundTask[] = []
  private tools: SessionTools
  /** Context already shown with a message that Claude Code hasn't taken in yet, so it isn't shown twice. */
  private shownContext?: Promise<string | undefined>

  constructor(opts: {
    id: string
    cwd: string
    mode: PermissionMode
    model?: string
    resume: boolean
    /** Start in this new worktree (Claude Code's --worktree), resuming or not; empty lets Claude name it. */
    worktree?: string
    tools: SessionTools
    onClose: () => void
    onChange: () => void
    onTurnEnd: () => void
  }) {
    this.id = opts.id
    this.cwd = opts.cwd
    this.mode = opts.mode
    this.model = opts.model
    this.makingWorktree = opts.worktree !== undefined
    this.tools = opts.tools
    this.onClose = opts.onClose
    this.onChange = opts.onChange
    this.onTurnEnd = opts.onTurnEnd
    this.checks = new AutoChecks((toolUseIds) => this.emit({ type: 'checking', sessionId: this.id, toolUseIds }))
    this.outbox = new Outbox((messages) => this.emit({ type: 'queued', sessionId: this.id, messages }))
    this.permissions = new Permissions(this.id, (e) => this.emit(e), {
      asked: (toolUseId) => this.checks.done(toolUseId),
      agent: (agentId) => this.agents.get(agentId),
    })
    this.bash = new BashStreams(
      this.id,
      (toolUseId, chunk) => this.emit({ type: 'bash_output', sessionId: this.id, toolUseId, chunk }),
      (toolUseId) => this.checks.done(toolUseId),
    )

    this.agent = query({
      prompt: this.queue,
      options: sdkOptions({
        id: this.id,
        cwd: this.cwd,
        mode: this.mode,
        model: opts.model,
        resume: opts.resume,
        worktree: opts.worktree,
        mcpServers: opts.tools.mcpServers,
        allowedTools: opts.tools.allowedTools,
        env: opts.tools.env,
        canUseTool: this.permissions.canUseTool,
        hooks: {
          promptContext: async () => {
            const additionalContext = await this.context()
            const shown = await this.shownContext
            this.shownContext = undefined
            if (!additionalContext) return undefined
            this.tools.contextAdded?.(additionalContext)
            if (additionalContext !== shown) this.record({ type: 'hook_context', uuid: randomUUID(), text: additionalContext })
            return additionalContext
          },
          toolStarting: (toolUseId, toolName) => this.toolUses.set(toolUseId, toolName),
          bashStarting: (toolUseId, command) => this.bash.track(toolUseId, command),
          toolFinished: (toolUseId) => this.toolUses.delete(toolUseId),
          moved: (cwd) => this.setCwd(cwd),
        },
      }),
    })
    void this.pump()
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** This process's turns in order, and the state only it has. The hub adds the history from earlier processes. */
  snapshot(): LiveSnapshot {
    return {
      ...this.status(),
      messages: [...this.live],
      permissions: this.permissions.list(),
      bashOutput: this.bash.outputs(),
      checking: this.checks.ids(),
      background: this.background,
      queued: this.outbox.list(),
    }
  }

  send(text: string, pastes: string[] = [], images: ImageAttachment[] = []): boolean {
    // Images go first: Claude does best with images before the text about them.
    const blocks = [
      ...images.map((i) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: i.mediaType, data: i.data } })),
      ...[...(text ? [text] : []), ...pastes.map(wrapPaste)].map((t) => ({ type: 'text' as const, text: t })),
    ]
    const message = {
      type: 'user' as const,
      uuid: randomUUID(),
      session_id: this.id,
      parent_tool_use_id: null,
      message: { role: 'user' as const, content: pastes.length || images.length ? blocks : text },
    }
    if (!this.queue.push(message)) return false
    if (this.running) {
      // Claude Code holds it until its next break; it joins the transcript once it's taken in, and can be withdrawn until then.
      this.outbox.hold({ id: message.uuid, text, pastes, images, message: message as unknown as WireMessage })
    } else {
      // Echo immediately so every tab shows the message before the SDK replays it.
      this.record({ ...message, timestamp: new Date().toISOString() } as unknown as WireMessage)
      // Shown with the message now rather than when Claude Code takes it in, which can be a while for a new worktree.
      this.shownContext = this.context().then((text) => {
        if (text) this.record({ type: 'hook_context', uuid: randomUUID(), text })
        return text
      })
      this.setRunning(true)
    }
    return true
  }

  /** Carries out what a browser asked of this chat. */
  async command(c: ChatCommand): Promise<ChatCommandReply> {
    switch (c.type) {
      case 'interrupt':
        return this.interrupt()
      case 'unqueue':
        return this.unqueue(c.id)
      case 'stop_task':
        return void (await this.agent.stopTask(c.taskId))
      case 'background_task':
        return void (await this.agent.backgroundTasks(c.toolUseId))
      case 'set_mode':
        await this.agent.setPermissionMode(c.mode)
        this.mode = c.mode
        return this.emitStatus()
      case 'set_model':
        await this.agent.setModel(c.model === 'default' ? undefined : c.model)
        this.model = c.model
        return this.emitStatus()
      case 'permission':
        return this.permissions.resolve(c.requestId, c.decision, c.message, c.updatedInput)
      // False if the question or plan is no longer pending.
      case 'answer_draft':
        return this.permissions.draftAnswers(c.requestId, c.answers)
      case 'plan_draft':
        return this.permissions.draftPlan(c.requestId, c.plan)
    }
  }

  /** Withdraws a queued message from Claude Code. Undefined if it was already taken in. */
  private async unqueue(id: string): Promise<QueuedMessage | undefined> {
    // In the SDK but not yet in its types.
    const cancel = (this.agent as Query & { cancelAsyncMessage?: (uuid: string) => Promise<boolean> }).cancelAsyncMessage
    const queued = this.outbox.get(id)
    if (!queued || !cancel || !(await cancel.call(this.agent, id))) return
    // Claude Code also reports it cancelled, usually first; either takes it off the list.
    this.outbox.take(id)
    return publicQueued(queued)
  }

  /** Messages Claude Code is holding mean the turn that's ending isn't the last. */
  get hasQueued(): boolean {
    return this.outbox.size > 0
  }

  async interrupt(): Promise<void> {
    this.permissions.interrupt()
    await this.agent.interrupt().catch(() => {})
  }

  /**
   * The tool_use_id of the call to this tool that's running now. Called from
   * the tool's own handler; MCP doesn't pass it, so it comes from PreToolUse.
   */
  takeToolUse(toolName: string): string | undefined {
    const ids = [...this.toolUses].filter(([, name]) => name === toolName).map(([id]) => id)
    // Calls that were denied before running never got here; drop them with this one.
    for (const id of ids) this.toolUses.delete(id)
    return ids.at(-1)
  }

  /** How full the chat's context is, as Claude Code's /context counts it. */
  contextUsage() {
    return readContext(this.agent)
  }

  /** The account's plan limits, as this process reads them. */
  planUsage() {
    return readLimits(this.agent)
  }

  /** Taking a turn, or waiting on background work it started: closing it now would cut that off. */
  get working(): boolean {
    return this.running || this.busy
  }

  /** A permission prompt or question is waiting on the user. */
  get waiting(): boolean {
    return this.permissions.waiting
  }

  /** Run once the current turn ends, e.g. cleanup that can't happen while this chat is still working in its directory. */
  afterTurn(fn: () => void): void {
    this.afterTurnCallbacks.push(fn)
  }

  close(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.queue.close()
    this.agent.close()
    this.bash.finishAll(true)
  }

  /** Tells this chat's viewers something from outside the process, e.g. that it started a child chat. */
  emitEvent(event: ServerEvent): void {
    this.emit(event)
  }

  private async pump(): Promise<void> {
    try {
      for await (const msg of this.agent) this.handle(msg)
    } catch (err) {
      this.emit({ type: 'error', sessionId: this.id, error: message(err) })
    } finally {
      this.queue.close()
      this.makingWorktree = false
      this.compacting = undefined
      this.setRunning(false)
      this.onClose()
    }
  }

  private handle(msg: SDKMessage): void {
    const wire = msg as unknown as WireMessage
    // Where a queued message stands in Claude Code's queue; not yet in the SDK's types.
    if (wire.type === 'command_lifecycle') {
      const { command_uuid: id, state } = wire as { command_uuid?: string; state?: string }
      const queued = id && (state === 'started' || state === 'cancelled') ? this.outbox.take(id) : undefined
      // Taken in, mid-turn after a tool result or as the next turn: it joins the transcript here.
      if (queued && state === 'started') {
        this.record({ ...queued.message, timestamp: new Date().toISOString() })
        this.setRunning(true)
      }
      return
    }
    if (msg.type === 'stream_event') {
      // Auto mode checks a message's calls as they stream in and holds back the message's end until it's decided on all of them.
      if (msg.event.type === 'message_delta') this.checks.messageDone(msg.parent_tool_use_id)
      this.emit({ type: 'message', sessionId: this.id, message: wire })
      return
    }
    if (msg.type === 'system' && msg.subtype === 'permission_denied') this.checks.done(msg.tool_use_id)
    if (msg.type === 'assistant' && this.mode === 'auto') this.checks.start(wire)
    // With --worktree, Claude Code reports where it actually ended up. Later inits (one per
    // turn) report wherever a Bash `cd` left Claude's shell, which isn't the chat moving.
    if (msg.type === 'system' && msg.subtype === 'init') {
      if (this.makingWorktree) {
        this.makingWorktree = false
        this.emitStatus()
      }
      if (this.awaitingInit) this.setCwd(msg.cwd)
      this.awaitingInit = false
      if (!this.model && msg.model) {
        this.model = msg.model
        this.emitStatus()
      }
    }
    if (msg.type === 'system' && 'permissionMode' in msg && msg.permissionMode) {
      const mode = msg.permissionMode as PermissionMode
      if (mode !== this.mode) {
        this.mode = mode
        this.emitStatus()
      }
    }
    // Compacting is one call with no progress in between: Claude Code says when it starts and how it ended.
    if (msg.type === 'system' && msg.subtype === 'status') {
      const compacting = msg.status === 'compacting'
      if (compacting !== (this.compacting !== undefined)) {
        this.compacting = compacting ? Date.now() : undefined
        this.emitStatus()
      }
      // Claude Code doesn't save a failed compaction, so only this process's chat shows it.
      if (msg.compact_result === 'failed') this.record({ type: 'compact_failed', uuid: msg.uuid, error: msg.compact_error, timestamp: new Date().toISOString() })
    }
    if (msg.type === 'system' && msg.subtype === 'task_started' && msg.task_type === 'local_agent') this.agents.set(msg.task_id, msg.description)
    if (msg.type === 'system' && msg.subtype === 'background_tasks_changed') {
      const tasks = msg.tasks.filter((t) => !t.ambient)
      const busy = tasks.length > 0
      // The chat list shows a chat waiting on background work as working.
      if (busy !== this.busy) {
        this.busy = busy
        this.onChange()
      }
      // A running subagent's own tasks show inside it. One that has paused to wait on them isn't in the set, so they show here.
      const ids = new Set(tasks.map((t) => t.task_id))
      this.background = tasks.filter((t) => !t.parent_task_id || !ids.has(t.parent_task_id)).map((t) => ({ id: t.task_id, type: t.task_type, description: t.description }))
      this.emit({ type: 'background', sessionId: this.id, tasks: this.background })
      const live = new Set(msg.tasks.map((t) => t.task_id))
      for (const id of this.bash.backgroundTasks()) if (!live.has(id)) this.bash.taskEnded(id)
      if (!this.running) this.setRunning(false)
    }
    if (msg.type === 'user') {
      const ids = toolResultIds(wire)
      // A command left running in the background says so in its result, which is the only one in its message.
      const taskId = ids.length === 1 ? (wire.tool_use_result as { backgroundTaskId?: string } | undefined)?.backgroundTaskId : undefined
      for (const id of ids) {
        this.bash.result(id, taskId)
        this.checks.done(id)
      }
    }
    if (msg.type === 'system' && msg.subtype === 'task_notification') this.bash.taskEnded(msg.task_id)
    if (msg.type === 'result') {
      this.bash.finishAll()
      this.checks.done()
      wire.ended_at = Date.now()
    }
    if (!isTranscriptMessage(msg)) return
    // The SDK may replay the user message we already echoed; skip the duplicate.
    if (msg.type === 'user' && wire.uuid && this.live.some((m) => m.uuid === wire.uuid)) return
    this.record(wire)
    if (msg.type === 'result') {
      this.setRunning(false)
      this.onTurnEnd()
    } else if (msg.type === 'assistant') this.setRunning(true)
  }

  private record(message: WireMessage): void {
    this.live.push(message)
    this.emit({ type: 'message', sessionId: this.id, message })
  }

  private setRunning(running: boolean): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    if (!running && !this.busy) this.idleTimer = setTimeout(() => this.close(), IDLE_CLOSE_MS)
    if (running === this.running) return
    this.running = running
    this.emitStatus()
    this.onChange()
    if (!running) {
      // Outside this call stack: a callback may close this session.
      for (const fn of this.afterTurnCallbacks.splice(0)) setImmediate(fn)
    }
  }

  private setCwd(cwd: string): void {
    if (!cwd || cwd === this.cwd) return
    this.cwd = cwd
    this.emitStatus()
    this.onChange()
  }

  private status(): ChatStatus {
    return { running: this.running, makingWorktree: this.makingWorktree, compacting: this.compacting, mode: this.mode, model: this.model, cwd: this.cwd }
  }

  private emitStatus(): void {
    this.emit({ type: 'status', sessionId: this.id, ...this.status() })
  }

  /** The card context for the next turn. It comes from the hub, which may not answer, and then there's none. */
  private context(): Promise<string | undefined> {
    return (this.tools.turnContext?.() ?? Promise.resolve(undefined)).catch((err) => {
      console.error(`Card context for ${this.id} failed:`, message(err))
      return undefined
    })
  }

  private emit(event: ServerEvent): void {
    for (const listener of this.listeners) listener(event)
  }
}

/** Messages the client renders; everything else (hooks, rate limits, lifecycle) is dropped. */
function isTranscriptMessage(msg: SDKMessage): boolean {
  if (msg.type === 'user' || msg.type === 'assistant' || msg.type === 'result') return true
  return msg.type === 'system' && TRANSCRIPT_SYSTEM.has(msg.subtype)
}

/** Task events say how subagents and background work are going. Claude Code doesn't save them, so they only cover this process. */
const TRANSCRIPT_SYSTEM = new Set(['compact_boundary', 'model_refusal_fallback', 'task_started', 'task_progress', 'task_updated', 'task_notification'])

function toolResultIds(m: WireMessage): string[] {
  const content = (m.message as { content?: unknown } | undefined)?.content
  if (!Array.isArray(content)) return []
  return content.filter((b) => b?.type === 'tool_result' && b.tool_use_id).map((b) => b.tool_use_id as string)
}

/** Registry of live sessions; starts or resumes Claude Code processes on demand. */
export class SessionManager {
  private sessions = new Map<string, LiveSession>()

  constructor(
    private onChange: () => void,
    /** `cwd` is a getter: it changes if Claude moves into a worktree. */
    private tools: (sessionId: string, cwd: () => string) => SessionTools,
    private onTurnEnd: (sessionId: string) => void,
    /** Called with every session as it starts, before its first message. */
    private onOpen: (session: LiveSession) => void = () => {},
  ) {}

  get(id: string): LiveSession | undefined {
    return this.sessions.get(id)
  }

  /** Taking a turn, or waiting on background work it started. */
  isRunning(id: string): boolean {
    return !!this.sessions.get(id)?.working
  }

  all(): LiveSession[] {
    return [...this.sessions.values()]
  }

  /** Some live session, for asking Claude Code about the account rather than a chat. */
  any(): LiveSession | undefined {
    return this.sessions.values().next().value
  }

  /** Live sessions running in a directory, e.g. a worktree about to be removed. */
  in(cwd: string): LiveSession[] {
    return [...this.sessions.values()].filter((s) => s.cwd === cwd)
  }

  /** A chat in this directory is working, background work included: closing it would cut that off. */
  busyIn(cwd: string): boolean {
    return this.in(cwd).some((s) => s.working)
  }

  /** Return the live session, resuming it from disk or creating it as needed. */
  async open(id: string, opts: { cwd?: string; mode?: PermissionMode; model?: string; worktree?: string }): Promise<LiveSession> {
    const existing = this.sessions.get(id)
    if (existing) return existing

    const info = await getSessionInfo(id)
    const cwd = info?.cwd ?? opts.cwd
    if (!cwd) throw new Error('Unknown session and no working directory given')
    // Otherwise Claude Code fails to start with a misleading "binary failed to launch".
    if (inaccessible(cwd)) throw new Error(info ? `This chat's folder is gone or can't be opened: ${cwd}` : `${cwd} doesn't exist or can't be opened`)

    const session = new LiveSession({
      id,
      cwd,
      mode: opts.mode ?? 'auto',
      model: opts.model,
      resume: !!info,
      // The hub only asks a chat that has run before to, when it's a fork that hasn't yet.
      worktree: opts.worktree,
      tools: this.tools(id, () => session.cwd),
      onClose: () => {
        if (this.sessions.get(id) === session) this.sessions.delete(id)
        this.onChange()
      },
      onChange: this.onChange,
      onTurnEnd: () => this.onTurnEnd(id),
    })
    this.sessions.set(id, session)
    this.onOpen(session)
    this.onChange()
    return session
  }

  closeAll(): void {
    for (const s of this.sessions.values()) s.close()
  }
}
