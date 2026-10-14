import { createHash, randomBytes } from 'node:crypto'
import type { DatabaseSync, StatementSync } from 'node:sqlite'
import { LOCAL_MACHINE, type Machine, type TerminalInfo } from '../shared/protocol.ts'
import { BadRequest } from './db.ts'
import { Peer, type Link } from './peer.ts'
import { HUB_ARGS, RUNNER_EVENT, RUNNER_PROTOCOL, isUuid, type HubApi, type LiveInfo, type RunnerApi, type RunnerEvent, type RunnerHello } from './runnerProtocol.ts'

/** The hub's own machine. */
export const LOCAL = LOCAL_MACHINE

/** A runner that's connected and has said hello. */
export interface Connection {
  id: string
  name: string
  peer: Peer<RunnerApi>
  hello: RunnerHello
  /** Its live chats, by id. */
  live: Map<string, LiveInfo>
  /** With the runner's own ids; `terminals()` gives the browser's. */
  terminals: TerminalInfo[]
  /** False until its PTY host has said what terminals there are. */
  terminalsKnown: boolean
}

interface MachineRow {
  id: string
  name: string
  named: number
  token_hash: string | null
  created_at: number
  last_seen: number | null
  info: string | null
}

export interface MachineEvents {
  /** A runner said hello or went away, or a machine was added, renamed or turned away. Anything a runner had live is gone with it. */
  onChange: (machine: Connection | undefined, id: string) => void
  onEvent: (machine: Connection, event: RunnerEvent) => void
}

/**
 * The machines chats run on and the runners connected for them. The hub's own
 * runner is always there; others connect with a token issued here, which is
 * kept only as a hash.
 *
 * Which machine each chat is on is decided here and nowhere else: a chat goes
 * where the browser started it, a child where its parent is. Runners only
 * ever act for chats already on their own machine.
 */
export class Machines {
  private connections = new Map<string, Connection>()
  /** Why each machine's runner was last turned away, until it connects. */
  private refusals = new Map<string, string>()
  private machineOfQuery?: StatementSync

  constructor(
    private db: DatabaseSync,
    private events: MachineEvents,
  ) {
    // Named after its host when its runner says hello, like any other.
    db.prepare("INSERT INTO machines (id, name, created_at) VALUES (?, 'This hub', ?) ON CONFLICT (id) DO NOTHING").run(LOCAL, Date.now())
  }

  list(): Machine[] {
    const rows = this.db.prepare('SELECT * FROM machines WHERE removed_at IS NULL ORDER BY id != ?, created_at').all(LOCAL) as unknown as MachineRow[]
    return rows.map((r) => {
      const live = this.connections.get(r.id)
      const info = live?.hello ?? (r.info ? (JSON.parse(r.info) as RunnerHello) : undefined)
      return {
        id: r.id,
        name: r.name,
        local: r.id === LOCAL,
        online: !!live,
        hostname: info?.hostname,
        platform: info?.platform,
        workspaceDir: info?.workspaceDir,
        scratchDir: info?.scratchDir,
        lastSeen: live ? Date.now() : (r.last_seen ?? undefined),
        running: live ? [...live.live.values()].filter((s) => s.running).length : 0,
        error: this.refusals.get(r.id),
        createdAt: r.created_at,
      }
    })
  }

  /** Removed machines keep their name, for their chats. */
  name(id: string): string {
    const row = this.db.prepare('SELECT name FROM machines WHERE id = ?').get(id) as { name: string } | undefined
    return row?.name ?? id
  }

  get(id: string): Connection | undefined {
    return this.connections.get(id)
  }

  /** The machine's runner, or an error saying it's offline. */
  require(id: string): Connection {
    const c = this.connections.get(id)
    if (!c) throw new BadRequest(`${this.name(id)} is offline`)
    return c
  }

  online(): Connection[] {
    return [...this.connections.values()]
  }

  /**
   * A new machine and the token its runner connects with. The token is shown
   * once. It's named after its host when its runner first says hello, unless
   * someone renames it first.
   */
  create(): { machine: Machine; token: string } {
    // Removed machines' ids stay taken, so their chats never turn up on a new machine.
    const taken = (id: string) =>
      id === LOCAL ||
      !!this.db.prepare('SELECT 1 FROM machines WHERE id = ?').get(id) ||
      !!this.db.prepare('SELECT 1 FROM chat_machines WHERE machine = ?').get(id)
    let id = 'runner'
    for (let n = 2; taken(id); n++) id = `runner-${n}`
    const token = newToken()
    this.db.prepare("INSERT INTO machines (id, name, token_hash, created_at) VALUES (?, 'New runner', ?, ?)").run(id, hash(token), Date.now())
    this.events.onChange(undefined, id)
    return { machine: this.list().find((m) => m.id === id)!, token }
  }

  /** Changes what a machine is called, for good: it's no longer named after its host. Its id, and so its chats, stay the same. */
  rename(id: string, name: unknown): Machine {
    const clean = typeof name === 'string' ? name.trim() : ''
    if (!clean) throw new BadRequest('Name is required')
    if (clean.length > 100) throw new BadRequest('Name is too long')
    if (!this.db.prepare('UPDATE machines SET name = ?, named = 1 WHERE id = ? AND removed_at IS NULL').run(clean, id).changes) {
      throw new BadRequest('No such runner')
    }
    const live = this.connections.get(id)
    if (live) live.name = clean
    this.events.onChange(live, id)
    return this.list().find((m) => m.id === id)!
  }

  /**
   * A new token for a machine, e.g. when its old one was lost. The machine and
   * its chats stay as they are; the old token stops working and a runner
   * connected with it is disconnected.
   */
  resetToken(id: string): { machine: Machine; token: string } {
    if (id === LOCAL) throw new BadRequest("The hub's own runner has no token")
    const token = newToken()
    if (!this.db.prepare('UPDATE machines SET token_hash = ? WHERE id = ? AND removed_at IS NULL').run(hash(token), id).changes) {
      throw new BadRequest('No such runner')
    }
    this.refusals.delete(id)
    if (!this.drop(id)) this.events.onChange(undefined, id)
    return { machine: this.list().find((m) => m.id === id)!, token }
  }

  /**
   * Retires a machine and disconnects it. Its chats stay, read-only for good:
   * its id is never used again, so no machine can pick them up.
   */
  remove(id: string): boolean {
    if (id === LOCAL) throw new BadRequest("The hub's own runner can't be removed")
    const removed =
      this.db.prepare('UPDATE machines SET removed_at = ?, token_hash = NULL WHERE id = ? AND removed_at IS NULL').run(Date.now(), id).changes > 0
    this.refusals.delete(id)
    if (!this.drop(id) && removed) this.events.onChange(undefined, id)
    return removed
  }

  /** Cuts a machine's runner off now: nothing more it sends is taken, even before its connection has finished closing. False if it wasn't connected. */
  private drop(id: string): boolean {
    const c = this.connections.get(id)
    if (!c) return false
    this.connections.delete(id)
    c.peer.close(true)
    this.db.prepare('UPDATE machines SET last_seen = ? WHERE id = ?').run(Date.now(), id)
    this.events.onChange(undefined, id)
    return true
  }

  /** Which machine a runner's token is for, if any. */
  byToken(token: string): string | undefined {
    const row = this.db.prepare('SELECT id FROM machines WHERE token_hash = ?').get(hash(token)) as { id: string } | undefined
    return row?.id
  }

  /** Remembers why a machine's runner was turned away, so the UI can say. */
  refused(id: string, why: string): void {
    if (this.refusals.get(id) === why) return
    this.refusals.set(id, why)
    this.events.onChange(undefined, id)
  }

  /**
   * Serves a runner over a link. It can't do anything until it has said
   * hello, and its token is checked again then, in case the machine was
   * removed or given a new token while it was connecting. A second connection
   * for the same machine replaces the first, e.g. after a network change left
   * the old one half-open. Only the current connection is listened to.
   * `token` is what a remote runner connected with; the hub's own has none.
   */
  attach(id: string, link: Link, api: (machine: string) => Omit<HubApi, 'hello'>, token?: string): void {
    let connection: Connection | undefined
    const current = () => !!connection && this.connections.get(id) === connection
    const hello = (hello: RunnerHello) => {
      if (hello.protocol !== RUNNER_PROTOCOL) {
        setImmediate(() => peer.close())
        const why = mismatch(hello.protocol)
        this.refused(id, why)
        throw new BadRequest(why)
      }
      const allowed = token === undefined ? id === LOCAL : this.byToken(token) === id
      if (!allowed) {
        setImmediate(() => peer.close(true))
        throw new Error('This runner was removed or given a new token')
      }
      this.connections.get(id)?.peer.close(true)
      this.refusals.delete(id)
      // Named after its host until someone names it.
      this.db.prepare('UPDATE machines SET name = ? WHERE id = ? AND named = 0').run(hello.hostname.split('.')[0] || hello.hostname, id)
      connection = { id, name: this.name(id), peer, hello, live: new Map(), terminals: [], terminalsKnown: false }
      this.connections.set(id, connection)
      this.db.prepare('UPDATE machines SET last_seen = ?, info = ? WHERE id = ?').run(Date.now(), JSON.stringify(hello), id)
      this.events.onChange(connection, id)
      return { id, name: connection.name, local: id === LOCAL, chats: this.chatsOn(id) }
    }
    const methods = Object.fromEntries(
      Object.entries(api(id)).map(([name, fn]) => [
        name,
        (...args: unknown[]) => {
          if (!current()) throw new BadRequest('Not connected: say hello first')
          return (fn as (...a: unknown[]) => unknown)(...args)
        },
      ]),
    )
    const peer: Peer<RunnerApi> = new Peer<RunnerApi>(
      link,
      { ...methods, hello },
      HUB_ARGS,
      (raw: unknown) => {
        const parsed = RUNNER_EVENT.safeParse(raw)
        if (!connection || !current() || !parsed.success) return
        const event = parsed.data as RunnerEvent
        if (event.type === 'live') {
          const live = new Map(event.sessions.filter((s) => this.owns(id, s.id)).map((s) => [s.id, s]))
          // Unchanged: nothing to tell anyone.
          if (JSON.stringify([...live]) === JSON.stringify([...connection.live])) return
          connection.live = live
        }
        if (event.type === 'terminals') {
          // A terminal says which chat started it; only one of this machine's.
          connection.terminals = event.terminals.map((t) => (t.sessionId && !this.owns(id, t.sessionId) ? { ...t, sessionId: undefined } : t))
          connection.terminalsKnown = true
        }
        this.events.onEvent(connection, event)
      },
      () => {
        if (!current()) return
        this.connections.delete(id)
        this.db.prepare('UPDATE machines SET last_seen = ? WHERE id = ?').run(Date.now(), id)
        this.events.onChange(undefined, id)
      },
    )
  }

  // ── Which machine each chat is on ──

  machineOf(sessionId: string): string | undefined {
    // Asked on every event a runner sends, so prepared once.
    this.machineOfQuery ??= this.db.prepare('SELECT machine FROM chat_machines WHERE session_id = ?')
    const row = this.machineOfQuery.get(sessionId) as { machine: string } | undefined
    return row?.machine
  }

  /** Whether a runner may act for this chat: it's a chat id, and the chat is on that runner's machine. */
  owns(machine: string, sessionId: unknown): sessionId is string {
    return isUuid(sessionId) && this.machineOf(sessionId) === machine
  }

  /**
   * Puts a chat on a machine, unless it's already somewhere: chats stay on the
   * machine they started on. Returns where it is. Only for chats the hub
   * starts; a runner can't put chats anywhere.
   */
  assign(sessionId: string, machine: string): string {
    this.db.prepare('INSERT INTO chat_machines (session_id, machine, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING').run(sessionId, machine, Date.now())
    return this.machineOf(sessionId)!
  }

  /** Every chat on a machine. */
  chatsOn(machine: string): string[] {
    const rows = this.db.prepare('SELECT session_id FROM chat_machines WHERE machine = ?').all(machine) as { session_id: string }[]
    return rows.map((r) => r.session_id)
  }

  machinesOf(sessionIds: string[]): Map<string, string> {
    const rows = this.db
      .prepare('SELECT session_id, machine FROM chat_machines WHERE session_id IN (SELECT value FROM json_each(?))')
      .all(JSON.stringify(sessionIds)) as { session_id: string; machine: string }[]
    return new Map(rows.map((r) => [r.session_id, r.machine]))
  }

  // ── Across every connected runner ──

  /** A live chat, wherever it runs. */
  live(sessionId: string): LiveInfo | undefined {
    for (const c of this.connections.values()) {
      const s = c.live.get(sessionId)
      if (s) return s
    }
    return undefined
  }

  allLive(): LiveInfo[] {
    return [...this.connections.values()].flatMap((c) => [...c.live.values()])
  }

  /** Every terminal on every connected machine, with the ids the browser uses. */
  terminals(): TerminalInfo[] {
    return [...this.connections.values()].flatMap((c) => c.terminals.map((t) => ({ ...t, id: `${c.id}.${t.id}`, machine: c.id })))
  }

  /** False until every connected machine has said what terminals it has. */
  terminalsKnown(): boolean {
    return [...this.connections.values()].every((c) => c.terminalsKnown)
  }

  /** A browser's terminal id, split into the machine's runner and its own id. */
  terminal(globalId: string): { machine: Connection; id: string } | undefined {
    const dot = globalId.lastIndexOf('.')
    const machine = this.connections.get(globalId.slice(0, dot))
    return dot > 0 && machine ? { machine, id: globalId.slice(dot + 1) } : undefined
  }

  /**
   * Takes a terminal a runner just created or restarted into its list. The
   * runner's own list broadcasts are throttled; this way the browser can open
   * it straight away. Returns it with the browser's id.
   */
  upsertTerminal(machine: Connection, info: TerminalInfo): TerminalInfo {
    const i = machine.terminals.findIndex((t) => t.id === info.id)
    machine.terminals = i < 0 ? [...machine.terminals, info] : machine.terminals.with(i, info)
    return { ...info, id: `${machine.id}.${info.id}`, machine: machine.id }
  }
}

/** What a runner on another protocol version is told, and what the UI shows for it. */
export const mismatch = (theirs: unknown) =>
  `The runner speaks protocol v${theirs ?? '?'} and the hub v${RUNNER_PROTOCOL}: update ${Number(theirs) < RUNNER_PROTOCOL ? 'the runner' : 'the hub'}.`

/** What a runner connects with. Only its hash is kept. */
const newToken = () => `badger_${randomBytes(24).toString('base64url')}`

const hash = (token: string) => createHash('sha256').update(token).digest('hex')
