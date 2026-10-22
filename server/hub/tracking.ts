import type { ServerEvent, TerminalInfo, WireMessage } from '../../shared/protocol.ts'
import type { Analytics } from '../analytics.ts'
import type { LiveInfo, RunnerHello } from '../runnerProtocol.ts'

/** What's known of a live chat between its events. */
interface ChatState {
  running?: boolean
  /** When its current turn (or background work) started, while it's running. */
  since?: number
  /** Nothing from Claude yet this turn. */
  awaitingOutput?: boolean
  compacting?: number
  mode?: string
  model?: string
  cwd?: string
}

/**
 * Turns what runners tell the hub into analytics events: chats' processes
 * starting and stopping, turns and what they cost, permission prompts, and
 * terminals. Keeps what it last heard of each, so only changes are recorded.
 */
export class HubTracking {
  private readonly started = Date.now()
  private chats = new Map<string, ChatState>()
  /** By machine, its live chats and when each was first seen live. */
  private processes = new Map<string, Map<string, number>>()
  /** By machine, its terminals as last listed, by global id. */
  private terminals = new Map<string, Map<string, TerminalInfo>>()
  /** Machines whose next terminal list is their first since the hub started or they reconnected. */
  private relisting = new Set<string>()
  /** When each machine's runner connected. */
  private connected = new Map<string, number>()

  constructor(private analytics: Analytics) {}

  runner(machine: string, state: 'connected' | 'disconnected', hello?: RunnerHello): void {
    if (state === 'connected') {
      this.connected.set(machine, Date.now())
      this.analytics.event('runner.connect', { actor: 'system', machine, data: hello && { hostname: hello.hostname, platform: hello.platform, protocol: hello.protocol } })
      return
    }
    const since = this.connected.get(machine)
    this.connected.delete(machine)
    this.analytics.event('runner.disconnect', { actor: 'system', machine, durationMs: since && Date.now() - since })
    // Its chats' processes went with it. Its terminals carry on; what became of them is seen in its next list.
    this.live(machine, [], 'disconnected')
    this.relisting.add(machine)
  }

  /** A machine's live chats, as it lists them whenever one starts, closes or changes. */
  live(machine: string, sessions: LiveInfo[], why = 'closed'): void {
    let known = this.processes.get(machine)
    if (!known) this.processes.set(machine, (known = new Map()))
    const now = Date.now()
    for (const s of sessions) {
      if (known.has(s.id)) continue
      known.set(s.id, now)
      // Already running when the hub started or the runner reconnected, rather than started now.
      const found = !this.connected.has(machine) || now - (this.connected.get(machine) ?? 0) < 5000 || now - this.started < 5000
      this.analytics.event(found ? 'process.found' : 'process.start', { actor: 'system', machine, sessionId: s.id, data: { cwd: s.cwd } })
    }
    const ids = new Set(sessions.map((s) => s.id))
    for (const [id, since] of known) {
      if (ids.has(id)) continue
      known.delete(id)
      this.analytics.event('process.end', { actor: 'system', machine, sessionId: id, durationMs: now - since, data: { why } })
      const chat = this.chats.get(id)
      if (chat?.running) this.status(id, { running: false })
      this.chats.delete(id)
    }
  }

  /** A live chat's event, already checked to be from its own machine. */
  sessionEvent(e: ServerEvent): void {
    if (!('sessionId' in e) || !e.sessionId) return
    const sessionId = e.sessionId
    switch (e.type) {
      case 'status':
        return this.status(sessionId, e)
      case 'message':
        return this.message(sessionId, e.message)
      case 'permission_request': {
        const p = e.permission
        this.analytics.event('permission.ask', {
          actor: { source: 'claude', sessionId },
          sessionId,
          data: { requestId: p.requestId, tool: p.toolName, toolUseId: p.toolUseId, agent: p.agent, canAlwaysAllow: p.canAlwaysAllow, blockedPath: p.blockedPath },
        })
        return
      }
      case 'permission_resolved':
        return this.analytics.event('permission.resolved', { sessionId, data: { requestId: e.requestId } })
      case 'error':
        return this.analytics.event('chat.error', { actor: 'system', sessionId, data: { error: e.error.slice(0, 2000) } })
      case 'queued':
        return this.analytics.event('chat.queued', { sessionId, data: { count: e.messages.length } })
    }
  }

  private status(sessionId: string, s: Partial<Pick<Extract<ServerEvent, { type: 'status' }>, 'running' | 'compacting' | 'mode' | 'model' | 'cwd'>>): void {
    let chat = this.chats.get(sessionId)
    if (!chat) this.chats.set(sessionId, (chat = {}))
    const now = Date.now()
    if (s.running !== undefined && s.running !== chat.running) {
      // The first status a chat sends says what it is, not that it changed, unless it's started working.
      if (s.running) {
        chat.since = now
        chat.awaitingOutput = true
        this.analytics.event('chat.busy', { sessionId })
      } else if (chat.running) {
        this.analytics.event('chat.idle', { sessionId, durationMs: chat.since && now - chat.since })
        chat.since = chat.awaitingOutput = undefined
      }
      chat.running = s.running
    }
    if ('compacting' in s && !!s.compacting !== !!chat.compacting) {
      if (s.compacting) this.analytics.event('chat.compact_start', { sessionId })
      else this.analytics.event('chat.compact_end', { sessionId, durationMs: chat.compacting && now - chat.compacting })
      chat.compacting = s.compacting
    }
    // Mode and model as first heard aren't changes; the transcript has what they started as.
    for (const key of ['mode', 'model', 'cwd'] as const) {
      const value = s[key]
      if (value === undefined || value === chat[key]) continue
      if (chat[key] !== undefined) this.analytics.event(`chat.${key}`, { sessionId, data: { from: chat[key], to: value } })
      chat[key] = value
    }
  }

  private message(sessionId: string, m: WireMessage): void {
    const chat = this.chats.get(sessionId)
    if (chat?.awaitingOutput && (m.type === 'stream_event' || m.type === 'assistant')) {
      chat.awaitingOutput = false
      this.analytics.event('turn.first_output', { sessionId, durationMs: chat.since && Date.now() - chat.since })
    }
    if (m.type !== 'result') return
    // Claude Code doesn't write these to the transcript: the turn's cost, timings and how it ended. Its answer is there already.
    const { type: _t, uuid: _u, session_id: _s, result, permission_denials: denials, ...rest } = m as WireMessage & { result?: unknown; permission_denials?: { tool_name?: string }[] }
    this.analytics.event('turn.result', {
      sessionId,
      durationMs: typeof rest.duration_ms === 'number' ? rest.duration_ms : undefined,
      data: {
        ...rest,
        resultChars: typeof result === 'string' ? result.length : undefined,
        denials: Array.isArray(denials) ? denials.map((d) => d.tool_name) : undefined,
      },
    })
  }

  /** A machine's terminals, by global id, whenever any changes. */
  listTerminals(machine: string, list: TerminalInfo[]): void {
    let known = this.terminals.get(machine)
    const first = !known || this.relisting.delete(machine)
    if (!known) this.terminals.set(machine, (known = new Map()))
    const now = Date.now()
    for (const t of list) {
      const before = known.get(t.id)
      known.set(t.id, t)
      const fields = { machine, sessionId: t.sessionId, actor: t.sessionId ? { source: 'claude' as const, sessionId: t.sessionId } : undefined }
      if (!before) {
        // Ones already there when the hub first hears from the machine were started before it was listening.
        const kind = first && t.createdAt < now - 5000 ? 'terminal.found' : 'terminal.start'
        this.analytics.event(kind, { ...fields, data: { id: t.id, name: t.name, command: t.command, cwd: t.cwd, root: t.root, createdAt: t.createdAt } })
        continue
      }
      if (before.running && !t.running) {
        this.analytics.event('terminal.exit', { ...fields, durationMs: now - t.createdAt, data: { id: t.id, exitCode: t.exitCode, signal: t.signal } })
      } else if (!before.running && t.running) this.analytics.event('terminal.restart', { ...fields, data: { id: t.id } })
      if (String(before.ports ?? []) !== String(t.ports ?? [])) this.analytics.event('terminal.ports', { ...fields, data: { id: t.id, ports: t.ports ?? [] } })
      if (before.name !== t.name) this.analytics.event('terminal.rename', { ...fields, data: { id: t.id, from: before.name, to: t.name } })
    }
    const ids = new Set(list.map((t) => t.id))
    for (const [id, t] of known) {
      if (ids.has(id)) continue
      known.delete(id)
      this.analytics.event('terminal.close', { machine, sessionId: t.sessionId, durationMs: now - t.createdAt, data: { id } })
    }
  }
}
