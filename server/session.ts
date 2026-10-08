import { randomUUID } from 'node:crypto'
import {
  getSessionInfo,
  getSessionMessages,
  query,
  type CanUseTool,
  type McpServerConfig,
  type PermissionResult,
  type PermissionUpdate,
  type Query,
  type SDKMessage,
} from '@anthropic-ai/claude-agent-sdk'
import type { PendingPermission, PermissionMode, ServerEvent, WireMessage } from '../shared/protocol.ts'
import { BashStreams, streamEnv } from './bashStream.ts'
import { MessageQueue } from './queue.ts'

/** Close an idle Claude Code process after this long; the next message resumes it. */
const IDLE_CLOSE_MS = 15 * 60 * 1000

type Listener = (event: ServerEvent) => void

/** Extra tools for one chat: MCP servers by name, and which of their tools skip the permission prompt. */
export interface SessionTools {
  mcpServers: Record<string, McpServerConfig>
  allowedTools: string[]
  /** Text to add to the conversation alongside the user's next message, if any. */
  turnContext?: () => string | undefined
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
  readonly cwd: string
  mode: PermissionMode
  running = false

  private queue = new MessageQueue()
  private agent: Query
  private listeners = new Set<Listener>()
  private pending = new Map<string, Pending>()
  /** Non-streaming messages seen since this process started, keyed for dedupe with disk. */
  private live: WireMessage[] = []
  private idleTimer: NodeJS.Timeout | null = null
  private bash: BashStreams
  private onClose: () => void

  constructor(opts: { id: string; cwd: string; mode: PermissionMode; resume: boolean; tools: SessionTools; onClose: () => void }) {
    this.id = opts.id
    this.cwd = opts.cwd
    this.mode = opts.mode
    this.onClose = opts.onClose
    this.bash = new BashStreams(this.id, (toolUseId, chunk) =>
      this.emit({ type: 'bash_output', sessionId: this.id, toolUseId, chunk }),
    )

    this.agent = query({
      prompt: this.queue,
      options: {
        cwd: this.cwd,
        ...(opts.resume ? { resume: this.id } : { sessionId: this.id }),
        permissionMode: this.mode,
        allowDangerouslySkipPermissions: true,
        includePartialMessages: true,
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        settingSources: ['user', 'project', 'local'],
        canUseTool: this.canUseTool,
        mcpServers: opts.tools.mcpServers,
        allowedTools: opts.tools.allowedTools,
        // Newer models omit thinking text by default; ask for summaries so it can stream.
        thinking: { type: 'adaptive', display: 'summarized' },
        env: streamEnv(),
        hooks: {
          UserPromptSubmit: [
            {
              hooks: [
                async () => {
                  const additionalContext = opts.tools.turnContext?.()
                  if (!additionalContext) return { continue: true }
                  return { continue: true, hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext } }
                },
              ],
            },
          ],
          PreToolUse: [
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
        },
      },
    })
    void this.pump()
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Transcript from disk merged with anything newer that only exists in memory. */
  async snapshot(): Promise<ServerEvent> {
    // Disk holds history from earlier processes; `live` holds this process's turns in order.
    const disk = (await getSessionMessages(this.id).catch(() => [])) as unknown as WireMessage[]
    const seen = new Set(this.live.map((m) => m.uuid))
    const messages = [...disk.filter((m) => !seen.has(m.uuid)), ...this.live]
    return {
      type: 'snapshot',
      sessionId: this.id,
      messages,
      running: this.running,
      mode: this.mode,
      cwd: this.cwd,
      permissions: [...this.pending.values()].map(publicPermission),
      bashOutput: this.bash.outputs(),
    }
  }

  send(text: string): boolean {
    const message = {
      type: 'user' as const,
      uuid: randomUUID(),
      session_id: this.id,
      parent_tool_use_id: null,
      message: { role: 'user' as const, content: text },
    }
    if (!this.queue.push(message)) return false
    // Echo immediately so every tab shows the message before the SDK replays it.
    this.record(message as unknown as WireMessage)
    this.setRunning(true)
    return true
  }

  async interrupt(): Promise<void> {
    for (const p of this.pending.values()) p.resolve({ behavior: 'deny', message: 'Interrupted by user', interrupt: true })
    await this.agent.interrupt().catch(() => {})
  }

  async setMode(mode: PermissionMode): Promise<void> {
    await this.agent.setPermissionMode(mode)
    this.mode = mode
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

  close(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.queue.close()
    this.agent.close()
    this.bash.finishAll()
  }

  private canUseTool: CanUseTool = (toolName, input, { signal, suggestions, blockedPath, toolUseID }) =>
    new Promise<PermissionResult>((resolve) => {
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
      this.setRunning(false)
      this.onClose()
    }
  }

  private handle(msg: SDKMessage): void {
    const wire = msg as unknown as WireMessage
    if (msg.type === 'stream_event') {
      this.emit({ type: 'message', sessionId: this.id, message: wire })
      return
    }
    if (msg.type === 'system' && 'permissionMode' in msg && msg.permissionMode) {
      const mode = msg.permissionMode as PermissionMode
      if (mode !== this.mode) {
        this.mode = mode
        this.emitStatus()
      }
    }
    if (msg.type === 'user') for (const id of toolResultIds(wire)) this.bash.finish(id)
    if (msg.type === 'result') this.bash.finishAll()
    if (!isTranscriptMessage(msg)) return
    // The SDK may replay the user message we already echoed; skip the duplicate.
    if (msg.type === 'user' && wire.uuid && this.live.some((m) => m.uuid === wire.uuid)) return
    this.record(wire)
    if (msg.type === 'result') this.setRunning(false)
    else if (msg.type === 'assistant') this.setRunning(true)
  }

  private record(message: WireMessage): void {
    this.live.push(message)
    this.emit({ type: 'message', sessionId: this.id, message })
  }

  private setRunning(running: boolean): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    if (!running) this.idleTimer = setTimeout(() => this.close(), IDLE_CLOSE_MS)
    if (running === this.running) return
    this.running = running
    this.emitStatus()
  }

  private emitStatus(): void {
    this.emit({ type: 'status', sessionId: this.id, running: this.running, mode: this.mode })
  }

  private emit(event: ServerEvent): void {
    for (const listener of this.listeners) listener(event)
  }
}

/** Messages the client renders; everything else (hooks, rate limits, lifecycle) is dropped. */
function isTranscriptMessage(msg: SDKMessage): boolean {
  if (msg.type === 'user' || msg.type === 'assistant' || msg.type === 'result') return true
  return msg.type === 'system' && msg.subtype === 'compact_boundary'
}

function toolResultIds(m: WireMessage): string[] {
  const content = (m.message as { content?: unknown } | undefined)?.content
  if (!Array.isArray(content)) return []
  return content.filter((b) => b?.type === 'tool_result' && b.tool_use_id).map((b) => b.tool_use_id as string)
}

function publicPermission({ resolve: _r, suggestions: _s, ...rest }: Pending): PendingPermission {
  return rest
}

/** Registry of live sessions; starts or resumes Claude Code processes on demand. */
export class SessionManager {
  private sessions = new Map<string, LiveSession>()

  constructor(
    private onChange: () => void,
    private tools: (sessionId: string, cwd: string) => SessionTools,
  ) {}

  get(id: string): LiveSession | undefined {
    return this.sessions.get(id)
  }

  isRunning(id: string): boolean {
    return this.sessions.get(id)?.running ?? false
  }

  liveIds(): string[] {
    return [...this.sessions.keys()]
  }

  /** Return the live session, resuming it from disk or creating it as needed. */
  async open(id: string, opts: { cwd?: string; mode?: PermissionMode }): Promise<LiveSession> {
    const existing = this.sessions.get(id)
    if (existing) return existing

    const info = await getSessionInfo(id)
    const cwd = info?.cwd ?? opts.cwd
    if (!cwd) throw new Error('Unknown session and no working directory given')

    const session = new LiveSession({
      id,
      cwd,
      mode: opts.mode ?? 'auto',
      resume: !!info,
      tools: this.tools(id, cwd),
      onClose: () => {
        if (this.sessions.get(id) === session) this.sessions.delete(id)
        this.onChange()
      },
    })
    this.sessions.set(id, session)
    this.onChange()
    return session
  }

  closeAll(): void {
    for (const s of this.sessions.values()) s.close()
  }
}
