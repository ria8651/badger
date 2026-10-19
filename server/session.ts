import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import {
  getSessionInfo,
  query,
  type CanUseTool,
  type McpServerConfig,
  type Options,
  type PermissionResult,
  type PermissionUpdate,
  type Query,
  type SDKMessage,
} from '@anthropic-ai/claude-agent-sdk'
import type { AnswerDraft, BackgroundTask, ImageAttachment, ModelOption, PendingPermission, PermissionMode, QueuedMessage, ServerEvent, WireMessage } from '../shared/protocol.ts'
import { wrapPaste } from '../shared/pastes.ts'
import { BashStreams, streamEnv } from './bashStream.ts'
import type { LiveSnapshot } from './runnerProtocol.ts'
import { SCRIPT_TOOL } from './scripts.ts'
import { inaccessible } from './workspace.ts'
import { MessageQueue } from './queue.ts'

/**
 * Claude Code won't start at all with the flag that allows switching to bypass
 * permissions when it runs as root, unless IS_SANDBOX=1 says it's sandboxed.
 * Without the flag it refuses bypass itself, with its own message.
 */
const CAN_BYPASS = process.getuid?.() !== 0 || process.env.IS_SANDBOX === '1'

/** Close an idle Claude Code process after this long; the next message resumes it. */
const IDLE_CLOSE_MS = 15 * 60 * 1000
/** Allowed in auto mode without asking the classifier. */
const READ_ONLY_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead', 'TodoWrite', 'ToolSearch', 'TaskOutput'])

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

/** A queued message, with what was sent to Claude Code so it can join the transcript once taken in. */
interface Held extends QueuedMessage {
  message: WireMessage
}

interface Pending extends PendingPermission {
  suggestions?: PermissionUpdate[]
  resolve: (result: PermissionResult) => void
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

  private queue = new MessageQueue()
  private agent: Query
  private listeners = new Set<Listener>()
  private pending = new Map<string, Pending>()
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
  /** Calls auto mode's classifier is still deciding on: tool_use_id to the subagent's call, or null for the chat's own. */
  private checking = new Map<string, string | null>()
  /** Until the first init: only that one says where --worktree put us. */
  private awaitingInit = true
  private afterTurnCallbacks: (() => void)[] = []
  /** Subagents' descriptions by agent id, to say which one is asking for permission. */
  private agents = new Map<string, string>()
  /** Started from the chat itself and running now. They outlive the turn that started them. */
  private background: BackgroundTask[] = []
  /** Sent while Claude was busy and not taken in yet; Claude Code holds them until its next break or turn. */
  private queued: Held[] = []
  /** Any background work is running, the subagents' own included; closing the process would kill it. */
  busy = false
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
    this.bash = new BashStreams(
      this.id,
      (toolUseId, chunk) => this.emit({ type: 'bash_output', sessionId: this.id, toolUseId, chunk }),
      (toolUseId) => this.checked(toolUseId),
    )

    this.agent = query({
      prompt: this.queue,
      options: {
        cwd: this.cwd,
        ...(opts.resume ? { resume: this.id } : { sessionId: this.id }),
        permissionMode: this.mode,
        ...(opts.model && opts.model !== 'default' ? { model: opts.model } : {}),
        // So the chat can switch to bypass later.
        allowDangerouslySkipPermissions: CAN_BYPASS,
        includePartialMessages: true,
        // Subagents' text and thinking too, not just their tool calls, so they show live as the chat's own do.
        // Claude Code streams only the chat's own messages token by token; a subagent's arrive a block at a time.
        forwardSubagentText: true,
        // A one-line "what it's doing" for each running subagent, every ~30s.
        agentProgressSummaries: true,
        // Each task has its own Stop, so stopping the turn leaves background work running.
        perTaskStopAffordance: true,
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        settingSources: ['user', 'project', 'local'],
        canUseTool: this.canUseTool,
        mcpServers: opts.tools.mcpServers,
        // Newer models omit thinking text by default; ask for summaries so it can stream.
        thinking: { type: 'adaptive', display: 'summarized' },
        env: { ...streamEnv(), ...opts.tools.env },
        ...(opts.worktree !== undefined ? { extraArgs: { worktree: opts.worktree || null } } : {}),
        hooks: {
          UserPromptSubmit: [
            {
              hooks: [
                async () => {
                  const additionalContext = await this.context()
                  const shown = await this.shownContext
                  this.shownContext = undefined
                  if (!additionalContext) return { continue: true }
                  this.tools.contextAdded?.(additionalContext)
                  if (additionalContext !== shown) this.record({ type: 'hook_context', uuid: randomUUID(), text: additionalContext })
                  return { continue: true, hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext } }
                },
              ],
            },
          ],
          PreToolUse: [
            {
              hooks: [
                async (input) => {
                  if (input.hook_event_name !== 'PreToolUse') return { continue: true }
                  this.toolUses.set(input.tool_use_id, input.tool_name)
                  // Allowed here, not with allowedTools: that would skip canUseTool too, and the SDK warns about it every start.
                  if (opts.tools.allowedTools.includes(input.tool_name)) {
                    return { continue: true, hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } }
                  }
                  return { continue: true }
                },
              ],
            },
            {
              matcher: 'Bash',
              hooks: [
                async (input) => {
                  if (input.hook_event_name === 'PreToolUse') {
                    const command = (input.tool_input as { command?: unknown })?.command
                    if (typeof command === 'string') this.bash.track(input.tool_use_id, command)
                  }
                  return { continue: true }
                },
              ],
            },
          ],
          // Claude can move itself into a worktree mid-chat; follow it so terminals do too.
          PostToolUse: [
            {
              hooks: [
                async (input) => {
                  if (input.hook_event_name === 'PostToolUse') this.toolUses.delete(input.tool_use_id)
                  return { continue: true }
                },
              ],
            },
            {
              matcher: 'EnterWorktree|ExitWorktree',
              hooks: [
                async (input) => {
                  this.setCwd(input.cwd)
                  return { continue: true }
                },
              ],
            },
          ],
        },
      },
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
      messages: [...this.live],
      running: this.running,
      makingWorktree: this.makingWorktree,
      compacting: this.compacting,
      mode: this.mode,
      model: this.model,
      cwd: this.cwd,
      permissions: [...this.pending.values()].map(publicPermission),
      bashOutput: this.bash.outputs(),
      checking: [...this.checking.keys()],
      background: this.background,
      queued: this.queued.map(publicQueued),
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
      this.queued.push({ id: message.uuid, text, pastes, images, message: message as unknown as WireMessage })
      this.emitQueued()
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

  /** Withdraws a queued message from Claude Code. Undefined if it was already taken in. */
  async unqueue(id: string): Promise<QueuedMessage | undefined> {
    // In the SDK but not yet in its types.
    const cancel = (this.agent as Query & { cancelAsyncMessage?: (uuid: string) => Promise<boolean> }).cancelAsyncMessage
    const queued = this.queued.find((m) => m.id === id)
    if (!queued || !cancel || !(await cancel.call(this.agent, id))) return
    // Claude Code also reports it cancelled, usually first; either takes it off the list.
    this.dequeue(id)
    return publicQueued(queued)
  }

  /** Messages Claude Code is holding mean the turn that's ending isn't the last. */
  get hasQueued(): boolean {
    return this.queued.length > 0
  }

  async interrupt(): Promise<void> {
    for (const p of this.pending.values()) p.resolve({ behavior: 'deny', message: 'Interrupted by user', interrupt: true })
    await this.agent.interrupt().catch(() => {})
  }

  async stopTask(taskId: string): Promise<void> {
    await this.agent.stopTask(taskId)
  }

  /** Moves a running subagent or command to the background so the turn carries on; without an id, every one. */
  async backgroundTask(toolUseId?: string): Promise<void> {
    await this.agent.backgroundTasks(toolUseId)
  }

  async setMode(mode: PermissionMode): Promise<void> {
    await this.agent.setPermissionMode(mode)
    this.mode = mode
    this.emitStatus()
  }

  async setModel(model: string): Promise<void> {
    await this.agent.setModel(model === 'default' ? undefined : model)
    this.model = model
    this.emitStatus()
  }

  resolvePermission(
    requestId: string,
    decision: 'allow' | 'allow_always' | 'deny',
    message?: string,
    updatedInput?: Record<string, unknown>,
  ): void {
    const p = this.pending.get(requestId)
    if (!p) return
    if (decision === 'deny') {
      p.resolve({ behavior: 'deny', message: message || 'The user denied this action.' })
    } else {
      p.resolve({
        behavior: 'allow',
        updatedInput: updatedInput ?? p.input,
        ...(decision === 'allow_always' && p.suggestions ? { updatedPermissions: p.suggestions } : {}),
      })
    }
  }

  /** Keeps answers picked so far with the pending question. False if it's no longer pending. */
  draftAnswers(requestId: string, answers: AnswerDraft): boolean {
    const p = this.pending.get(requestId)
    if (!p) return false
    p.answers = answers
    return true
  }

  /** Keeps the plan as edited so far with the pending ExitPlanMode. False if it's no longer pending. */
  draftPlan(requestId: string, plan: string): boolean {
    const p = this.pending.get(requestId)
    if (!p || p.toolName !== 'ExitPlanMode') return false
    p.plan = plan
    return true
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

  /** Asks this chat's Claude Code process something directly, e.g. how full its context is. */
  ask<T>(fn: (q: Query) => Promise<T>): Promise<T> {
    return fn(this.agent)
  }

  /** A permission prompt or question is waiting on the user. */
  get waiting(): boolean {
    return this.pending.size > 0
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

  private canUseTool: CanUseTool = (toolName, input, { signal, suggestions: offered, blockedPath, toolUseID, agentID }) =>
    new Promise<PermissionResult>((resolve) => {
      this.checked(toolUseID)
      // A script can do what any of Badger's tools can, so allowing scripts for good would allow all of them, unasked.
      const suggestions = toolName.endsWith(`__${SCRIPT_TOOL}`) ? undefined : offered
      const requestId = randomUUID()
      const done = (result: PermissionResult) => {
        if (!this.pending.delete(requestId)) return
        this.emit({ type: 'permission_resolved', sessionId: this.id, requestId })
        resolve(result)
      }
      const pending: Pending = {
        requestId,
        toolName,
        toolUseId: toolUseID,
        input,
        blockedPath,
        suggestions,
        canAlwaysAllow: !!suggestions?.length,
        ...(agentID ? { agent: this.agents.get(agentID) ?? 'A subagent' } : {}),
        resolve: done,
      }
      this.pending.set(requestId, pending)
      signal.addEventListener('abort', () => done({ behavior: 'deny', message: 'Aborted' }), { once: true })
      this.emit({ type: 'permission_request', sessionId: this.id, permission: publicPermission(pending) })
    })

  private async pump(): Promise<void> {
    try {
      for await (const msg of this.agent) this.handle(msg)
    } catch (err) {
      this.emit({ type: 'error', sessionId: this.id, error: err instanceof Error ? err.message : String(err) })
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
      const queued = id && (state === 'started' || state === 'cancelled') ? this.dequeue(id) : undefined
      // Taken in, mid-turn after a tool result or as the next turn: it joins the transcript here.
      if (queued && state === 'started') {
        this.record({ ...queued.message, timestamp: new Date().toISOString() })
        this.setRunning(true)
      }
      return
    }
    if (msg.type === 'stream_event') {
      // Auto mode checks a message's calls as they stream in and holds back the message's end until it's decided on all of them.
      if (msg.event.type === 'message_delta') this.checkedMessage(msg.parent_tool_use_id)
      this.emit({ type: 'message', sessionId: this.id, message: wire })
      return
    }
    if (msg.type === 'system' && msg.subtype === 'permission_denied') this.checked(msg.tool_use_id)
    if (msg.type === 'assistant' && this.mode === 'auto') this.startChecking(wire)
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
        this.checked(id)
      }
    }
    if (msg.type === 'system' && msg.subtype === 'task_notification') this.bash.taskEnded(msg.task_id)
    if (msg.type === 'result') {
      this.bash.finishAll()
      this.checked()
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

  /** Takes a message off the queued list, e.g. once Claude Code has taken it in or dropped it. */
  private dequeue(id: string): Held | undefined {
    const queued = this.queued.find((m) => m.id === id)
    if (!queued) return
    this.queued = this.queued.filter((m) => m !== queued)
    this.emitQueued()
    return queued
  }

  private emitQueued(): void {
    this.emit({ type: 'queued', sessionId: this.id, messages: this.queued.map(publicQueued) })
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

  /**
   * A call Claude has just made goes to auto mode's check. The chat's own
   * calls are followed until their message ends. A subagent's messages don't
   * stream here, so only its commands, which say when they start, are.
   */
  private startChecking(msg: WireMessage): void {
    const parent = (msg.parent_tool_use_id as string | null | undefined) ?? null
    const content = (msg.message as { content?: unknown } | undefined)?.content
    const uses = Array.isArray(content) ? (content as { type?: string; id?: string; name?: string }[]) : []
    let added = false
    for (const u of uses) {
      if (u.type !== 'tool_use' || !u.id || !u.name || READ_ONLY_TOOLS.has(u.name)) continue
      if (parent && u.name !== 'Bash') continue
      this.checking.set(u.id, parent)
      added = true
    }
    if (added) this.emitChecking()
  }

  /** A call is through auto mode's check, one way or another; without an id, every call. */
  private checked(toolUseId?: string): void {
    if (toolUseId ? !this.checking.delete(toolUseId) : !this.checking.size) return
    if (!toolUseId) this.checking.clear()
    this.emitChecking()
  }

  /** A message ended, so auto mode has decided on all of its calls: the chat's own, or a subagent's. */
  private checkedMessage(parent: string | null): void {
    const ids = [...this.checking].filter(([, p]) => p === parent).map(([id]) => id)
    for (const id of ids) this.checking.delete(id)
    if (ids.length) this.emitChecking()
  }

  private emitChecking(): void {
    this.emit({ type: 'checking', sessionId: this.id, toolUseIds: [...this.checking.keys()] })
  }

  private emitStatus(): void {
    this.emit({ type: 'status', sessionId: this.id, running: this.running, makingWorktree: this.makingWorktree, compacting: this.compacting, mode: this.mode, model: this.model, cwd: this.cwd })
  }

  /** The card context for the next turn. It comes from the hub, which may not answer, and then there's none. */
  private context(): Promise<string | undefined> {
    return (this.tools.turnContext?.() ?? Promise.resolve(undefined)).catch((err) => {
      console.error(`Card context for ${this.id} failed:`, err instanceof Error ? err.message : err)
      return undefined
    })
  }

  /** Tells this chat's viewers something from outside the process, e.g. that it started a child chat. */
  emitEvent(event: ServerEvent): void {
    this.emit(event)
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

/**
 * Starts a Claude Code process just to ask it something, then closes it.
 * Nothing is sent to the model and nothing is saved. Settings aren't loaded
 * unless asked for, so the user's hooks don't run.
 */
export async function oneOff<T>(options: Options, fn: (q: Query) => Promise<T>): Promise<T> {
  const idle: AsyncIterable<never> = { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) }
  const q = query({ prompt: idle, options: { settingSources: [], ...options, persistSession: false } })
  try {
    return await fn(q)
  } finally {
    q.close()
  }
}

let models: Promise<ModelOption[]> | undefined

/** The models Claude Code offers this account, asked once. */
export function listModels(): Promise<ModelOption[]> {
  models ??= oneOff({ cwd: homedir(), settingSources: ['user'] }, async (q) => {
    const { models } = await q.initializationResult()
    return models.map(({ value, resolvedModel, displayName, description }) => ({ value, resolvedModel, displayName, description }))
  })
  // Ask again next time rather than keep a failure.
  models.catch(() => (models = undefined))
  return models
}

function publicQueued({ message: _, ...rest }: Held): QueuedMessage {
  return rest
}

function publicPermission({ resolve: _r, suggestions: _s, ...rest }: Pending): PendingPermission {
  return rest
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
    const s = this.sessions.get(id)
    return !!s && (s.running || s.busy)
  }

  all(): LiveSession[] {
    return [...this.sessions.values()]
  }

  /** Some live session, for asking Claude Code about the account rather than a chat. */
  any(): LiveSession | undefined {
    return this.sessions.values().next().value
  }

  /** Return the live session, resuming it from disk or creating it as needed. */
  /** Live sessions running in a directory, e.g. a worktree about to be removed. */
  in(cwd: string): LiveSession[] {
    return [...this.sessions.values()].filter((s) => s.cwd === cwd)
  }

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
