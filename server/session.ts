import { randomUUID } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
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
  /** Changes when Claude moves into or out of a worktree. */
  cwd: string
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
  private onCwd: () => void
  /** Tool calls that have started, by tool_use_id, so a tool's handler can find out which call it is. */
  private toolUses = new Map<string, string>()
  private afterTurnCallbacks: (() => void)[] = []

  constructor(opts: {
    id: string
    cwd: string
    mode: PermissionMode
    resume: boolean
    /** Start a new session in this worktree (Claude Code's --worktree); empty lets Claude name it. */
    worktree?: string
    tools: SessionTools
    onClose: () => void
    onCwd: () => void
  }) {
    this.id = opts.id
    this.cwd = opts.cwd
    this.mode = opts.mode
    this.onClose = opts.onClose
    this.onCwd = opts.onCwd
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
        ...(opts.worktree !== undefined ? { extraArgs: { worktree: opts.worktree || null } } : {}),
        hooks: {
          UserPromptSubmit: [
            {
              hooks: [
                async () => {
                  const additionalContext = opts.tools.turnContext?.()
                  if (!additionalContext) return { continue: true }
                  this.record({ type: 'hook_context', uuid: randomUUID(), text: additionalContext })
                  return { continue: true, hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext } }
                },
              ],
            },
          ],
          PreToolUse: [
            {
              hooks: [
                async (input) => {
                  if (input.hook_event_name === 'PreToolUse') this.toolUses.set(input.tool_use_id, input.tool_name)
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

  /** Transcript from disk merged with anything newer that only exists in memory. */
  async snapshot(): Promise<Omit<Extract<ServerEvent, { type: 'snapshot' }>, 'draft' | 'children'>> {
    // Disk holds history from earlier processes; `live` holds this process's turns in order.
    const disk = await diskTranscript(this.id)
    const seen = new Set(this.live.map((m) => m.uuid))
    const messages = [...disk.filter((m) => !seen.has(m.uuid) && !seen.has(m.after_uuid as string)), ...this.live]
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
    this.record({ ...message, timestamp: new Date().toISOString() } as unknown as WireMessage)
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

  /** Run once the current turn ends, e.g. cleanup that can't happen while this chat is still working in its directory. */
  afterTurn(fn: () => void): void {
    this.afterTurnCallbacks.push(fn)
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
    // With --worktree, Claude Code reports where it actually ended up.
    if (msg.type === 'system' && msg.subtype === 'init') this.setCwd(msg.cwd)
    if (msg.type === 'system' && 'permissionMode' in msg && msg.permissionMode) {
      const mode = msg.permissionMode as PermissionMode
      if (mode !== this.mode) {
        this.mode = mode
        this.emitStatus()
      }
    }
    if (msg.type === 'user') for (const id of toolResultIds(wire)) this.bash.finish(id)
    if (msg.type === 'result') {
      this.bash.finishAll()
      wire.ended_at = Date.now()
    }
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
    if (!running) {
      // Outside this call stack: a callback may close this session.
      for (const fn of this.afterTurnCallbacks.splice(0)) setImmediate(fn)
    }
  }

  private setCwd(cwd: string): void {
    if (!cwd || cwd === this.cwd) return
    this.cwd = cwd
    this.emitStatus()
    this.onCwd()
  }

  private emitStatus(): void {
    this.emit({ type: 'status', sessionId: this.id, running: this.running, mode: this.mode, cwd: this.cwd })
  }

  private emit(event: ServerEvent): void {
    for (const listener of this.listeners) listener(event)
  }
}

/** A chat's transcript from disk, with what the SDK's reader leaves out put back: turn results and hook context. */
export async function diskTranscript(id: string): Promise<WireMessage[]> {
  const [messages, context] = await Promise.all([
    getSessionMessages(id).catch(() => []) as Promise<unknown> as Promise<WireMessage[]>,
    hookContext(id).catch(() => new Map<string, string[]>()),
  ])
  return withTurnResults(
    messages.flatMap((m) => [
      m,
      ...(context.get(m.uuid ?? '') ?? []).map((text, i) => ({ type: 'hook_context', uuid: `${m.uuid}-context-${i}`, after_uuid: m.uuid, text })),
    ]),
  )
}

const PROJECTS_DIR = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects')

/**
 * What UserPromptSubmit hooks added to each turn, by the uuid of the prompt it came with.
 * It's stored as attachment entries, which getSessionMessages skips, so read the file directly.
 */
async function hookContext(id: string): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>()
  const file = await transcriptFile(id)
  if (!file) return out
  type Entry = { type?: string; uuid?: string; parentUuid?: string; attachment?: { type?: string; hookEvent?: string; content?: unknown } }
  const parents = new Map<string, string>()
  const hooks: Entry[] = []
  for (const line of (await readFile(file, 'utf8')).split('\n')) {
    if (!line.includes('"attachment"')) continue
    let e: Entry
    try {
      e = JSON.parse(line)
    } catch {
      continue
    }
    if (e.type !== 'attachment' || !e.uuid || !e.parentUuid) continue
    parents.set(e.uuid, e.parentUuid)
    if (e.attachment?.type === 'hook_additional_context' && e.attachment.hookEvent === 'UserPromptSubmit') hooks.push(e)
  }
  for (const e of hooks) {
    // Attachments chain off each other; the first non-attachment ancestor is the prompt.
    let anchor = e.parentUuid!
    while (parents.has(anchor)) anchor = parents.get(anchor)!
    const content = Array.isArray(e.attachment!.content) ? e.attachment!.content.filter((c): c is string => typeof c === 'string') : []
    out.set(anchor, [...(out.get(anchor) ?? []), ...content])
  }
  return out
}

async function transcriptFile(id: string): Promise<string | undefined> {
  for (const dir of await readdir(PROJECTS_DIR).catch(() => [])) {
    const file = join(PROJECTS_DIR, dir, `${id}.jsonl`)
    if (await stat(file).then(() => true, () => false)) return file
  }
  return undefined
}

type Usage = { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }

/**
 * The transcript on disk has no result messages (time taken, tokens), so rebuild
 * one after each turn from message timestamps and each API call's usage.
 * Main agent only, like the live results the client shows.
 */
function withTurnResults(messages: WireMessage[]): WireMessage[] {
  const out: WireMessage[] = []
  let start: WireMessage | undefined
  let last: WireMessage | undefined
  let calls = new Map<string, Usage>()
  const close = () => {
    if (start && last?.uuid) {
      const usage: Required<Usage> = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
      for (const u of calls.values()) for (const k of Object.keys(usage) as (keyof Usage)[]) usage[k] += u[k] ?? 0
      const ended = Date.parse(String(last.timestamp))
      out.push({
        type: 'result',
        subtype: 'success',
        uuid: `${last.uuid}-result`,
        after_uuid: last.uuid,
        duration_ms: ended - Date.parse(String(start.timestamp)),
        ended_at: ended,
        usage,
      })
    }
    start = last = undefined
    calls = new Map()
  }
  for (const m of messages) {
    if (isPrompt(m)) {
      close()
      start = m
    } else if (start && m.type === 'assistant' && !m.parent_tool_use_id) {
      last = m
      // One API call is split into a line per content block, all sharing its id and usage.
      const msg = m.message as { id?: string; usage?: Usage } | undefined
      if (msg?.id && msg.usage) calls.set(msg.id, msg.usage)
    }
    out.push(m)
  }
  close()
  return out
}

/** A message the user typed, as opposed to tool results or injected context. */
function isPrompt(m: WireMessage): boolean {
  if (m.type !== 'user' || m.parent_tool_use_id || !m.timestamp) return false
  const content = (m.message as { content?: unknown } | undefined)?.content
  if (typeof content === 'string') return !content.trimStart().startsWith('<')
  return Array.isArray(content) && content.some((b) => b?.type === 'text' && !String(b.text).trimStart().startsWith('<'))
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
    /** `cwd` is a getter: it changes if Claude moves into a worktree. */
    private tools: (sessionId: string, cwd: () => string) => SessionTools,
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
  /** Live sessions running in a directory, e.g. a worktree about to be removed. */
  in(cwd: string): LiveSession[] {
    return [...this.sessions.values()].filter((s) => s.cwd === cwd)
  }

  async open(id: string, opts: { cwd?: string; mode?: PermissionMode; worktree?: string }): Promise<LiveSession> {
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
      // Only a new chat can start in a new worktree; a resumed one already runs where it left off.
      worktree: info ? undefined : opts.worktree,
      tools: this.tools(id, () => session.cwd),
      onClose: () => {
        if (this.sessions.get(id) === session) this.sessions.delete(id)
        this.onChange()
      },
      onCwd: this.onChange,
    })
    this.sessions.set(id, session)
    this.onChange()
    return session
  }

  closeAll(): void {
    for (const s of this.sessions.values()) s.close()
  }
}
