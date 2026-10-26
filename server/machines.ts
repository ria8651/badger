import { createHash, randomBytes } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { LOCAL_MACHINE, type Machine } from '../shared/protocol.ts'
import { BadRequest } from './errors.ts'
import { Peer, type Link, type Remote } from './peer.ts'
import type { ChatPlacement } from './placement.ts'
import {
  HUB_ARGS,
  RUNNER_EVENT,
  RUNNER_PROTOCOL,
  RUNNER_REPLIES,
  type HubApi,
  type HubEvent,
  type LiveInfo,
  type LiveSnapshot,
  type RunnerApi,
  type RunnerEvent,
  type RunnerHello,
} from './runnerProtocol.ts'

/** A runner that hasn't said hello by then is cut off. */
const HELLO_TIMEOUT_MS = 30 * 1000
/**
 * The longest the hub waits on any runner call, so one that never answers
 * can't pile them up. Generous: starting a chat in a new worktree, or sizing a
 * big folder, takes a while.
 */
const CALL_TIMEOUT_MS = 10 * 60 * 1000

/** A runner that's connected and has said hello. */
export class Connection {
  /** Its live chats, by id. */
  live = new Map<string, LiveInfo>()

  constructor(
    readonly id: string,
    public name: string,
    readonly hello: RunnerHello,
    private peer: Peer<RunnerApi>,
  ) {}

  /** The runner's methods. */
  get remote(): Remote<RunnerApi> {
    return this.peer.remote
  }

  /**
   * Its methods, giving up on an answer after `ms`. Only for quick questions
   * someone is waiting on: a half-open connection (a laptop gone to sleep)
   * answers nothing until the ping drops it.
   */
  within(ms: number): Remote<RunnerApi> {
    return this.peer.within(ms)
  }

  /** A live chat's state, or null with no process; `done` runs in order with the chat's events, so none falls between. */
  liveSnapshot(sessionId: string, known: string[], done: (err: Error | null, live?: LiveSnapshot | null) => void): void {
    this.peer.request('liveSnapshot', [sessionId, known], done)
  }

  /** A terminal's screen; `done` runs in order with its output, so none falls between. */
  termSnapshot(id: string, timeoutMs: number, done: (err: Error | null, data?: string) => void): void {
    this.peer.request('termSnapshot', [id], done, timeoutMs)
  }

  termInput(id: string, data: string): void {
    this.peer.emit({ type: 'term_input', id, data } satisfies HubEvent)
  }

  termResize(id: string, cols: number, rows: number): void {
    this.peer.emit({ type: 'term_resize', id, cols, rows } satisfies HubEvent)
  }

  /** Cuts it off now: nothing more it sends is taken. */
  close(): void {
    this.peer.close(true)
  }
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
  /**
   * A machine was added, renamed or turned away, or its runner said hello
   * (`connected`, even replacing a connection the hub hadn't seen drop) or
   * went away (`disconnected`). Anything a runner had live is gone with it.
   */
  onChange: (id: string, runner?: 'connected' | 'disconnected') => void
  onEvent: (machine: Connection, event: RunnerEvent) => void
}

/**
 * The machines chats run on and the runners connected for them. The hub's own
 * runner is always there; others connect with a token issued here, which is
 * kept only as a hash. Which machine each chat is on is `placement`'s.
 */
export class Machines {
  private connections = new Map<string, Connection>()
  /** Why each machine's runner was last turned away, until it connects. */
  private refusals = new Map<string, string>()

  constructor(
    private db: DatabaseSync,
    private placement: ChatPlacement,
    private events: MachineEvents,
  ) {
    // Named after its host when its runner says hello, like any other.
    db.prepare("INSERT INTO machines (id, name, created_at) VALUES (?, 'This hub', ?) ON CONFLICT (id) DO NOTHING").run(LOCAL_MACHINE, Date.now())
  }

  list(): Machine[] {
    const rows = this.db.prepare('SELECT * FROM machines WHERE removed_at IS NULL ORDER BY id != ?, created_at').all(LOCAL_MACHINE) as unknown as MachineRow[]
    return rows.map((r) => {
      const live = this.connections.get(r.id)
      const info = live?.hello ?? (r.info ? (JSON.parse(r.info) as RunnerHello) : undefined)
      return {
        id: r.id,
        name: r.name,
        local: r.id === LOCAL_MACHINE,
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
    if (!c) {
      const removed = !this.db.prepare('SELECT 1 FROM machines WHERE id = ? AND removed_at IS NULL').get(id)
      throw new BadRequest(`${this.name(id)} ${removed ? 'was removed' : 'is offline'}`)
    }
    return c
  }

  /** The connected runner for a machine a request names, defaulting to the hub's own. */
  fromRequest(value: unknown): Connection {
    if (value !== undefined && value !== null && typeof value !== 'string') throw new BadRequest('machine must be a string')
    return this.require(value || LOCAL_MACHINE)
  }

  /** Any connected runner, the hub's own first, for questions about the account rather than a chat. */
  any(): Connection | undefined {
    return this.connections.get(LOCAL_MACHINE) ?? this.online()[0]
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
    const taken = (id: string) => id === LOCAL_MACHINE || !!this.db.prepare('SELECT 1 FROM machines WHERE id = ?').get(id) || this.placement.used(id)
    let id = 'runner'
    for (let n = 2; taken(id); n++) id = `runner-${n}`
    const token = newToken()
    this.db.prepare("INSERT INTO machines (id, name, token_hash, created_at) VALUES (?, 'New runner', ?, ?)").run(id, hash(token), Date.now())
    this.events.onChange(id)
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
    this.events.onChange(id)
    return this.list().find((m) => m.id === id)!
  }

  /**
   * A new token for a machine, e.g. when its old one was lost. The machine and
   * its chats stay as they are; the old token stops working and a runner
   * connected with it is disconnected.
   */
  resetToken(id: string): { machine: Machine; token: string } {
    if (id === LOCAL_MACHINE) throw new BadRequest("The hub's own runner has no token")
    const token = newToken()
    if (!this.db.prepare('UPDATE machines SET token_hash = ? WHERE id = ? AND removed_at IS NULL').run(hash(token), id).changes) {
      throw new BadRequest('No such runner')
    }
    this.refusals.delete(id)
    if (!this.drop(id)) this.events.onChange(id)
    return { machine: this.list().find((m) => m.id === id)!, token }
  }

  /**
   * Retires a machine and disconnects it. Its chats stay, read-only for good:
   * its id is never used again, so no machine can pick them up.
   */
  remove(id: string): boolean {
    if (id === LOCAL_MACHINE) throw new BadRequest("The hub's own runner can't be removed")
    const removed =
      this.db.prepare('UPDATE machines SET removed_at = ?, token_hash = NULL WHERE id = ? AND removed_at IS NULL').run(Date.now(), id).changes > 0
    this.refusals.delete(id)
    if (!this.drop(id) && removed) this.events.onChange(id)
    return removed
  }

  /** Cuts a machine's runner off now: nothing more it sends is taken, even before its connection has finished closing. False if it wasn't connected. */
  private drop(id: string): boolean {
    const c = this.connections.get(id)
    if (!c) return false
    this.connections.delete(id)
    c.close()
    this.db.prepare('UPDATE machines SET last_seen = ? WHERE id = ?').run(Date.now(), id)
    this.events.onChange(id, 'disconnected')
    return true
  }

  /** A machine's folders added by hand and folders taken off the list, by path. */
  folders(machine: string): { added: Map<string, number>; hidden: Set<string> } {
    const rows = this.db.prepare('SELECT path, added_at, hidden_at FROM machine_folders WHERE machine = ?').all(machine) as {
      path: string
      added_at: number
      hidden_at: number | null
    }[]
    return {
      added: new Map(rows.filter((r) => r.hidden_at === null).map((r) => [r.path, r.added_at])),
      hidden: new Set(rows.filter((r) => r.hidden_at !== null).map((r) => r.path)),
    }
  }

  addFolder(machine: string, path: string): void {
    this.db
      .prepare(
        'INSERT INTO machine_folders (machine, path, added_at) VALUES (?, ?, ?) ON CONFLICT(machine, path) DO UPDATE SET added_at = excluded.added_at, hidden_at = NULL',
      )
      .run(machine, path, Date.now())
  }

  hideFolder(machine: string, path: string): void {
    const now = Date.now()
    this.db
      .prepare(
        'INSERT INTO machine_folders (machine, path, added_at, hidden_at) VALUES (?, ?, ?, ?) ON CONFLICT(machine, path) DO UPDATE SET hidden_at = excluded.hidden_at',
      )
      .run(machine, path, now, now)
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
    this.events.onChange(id)
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
    let greeted = false
    const current = () => !!connection && this.connections.get(id) === connection
    const silent = setTimeout(() => !greeted && peer.close(true), HELLO_TIMEOUT_MS)
    const hello = (hello: RunnerHello) => {
      if (greeted) throw new BadRequest('Already said hello')
      greeted = true
      clearTimeout(silent)
      if (hello.protocol !== RUNNER_PROTOCOL) {
        setImmediate(() => peer.close())
        const why = mismatch(hello.protocol)
        this.refused(id, why)
        throw new BadRequest(why)
      }
      const allowed = token === undefined ? id === LOCAL_MACHINE : this.byToken(token) === id
      if (!allowed) {
        setImmediate(() => peer.close(true))
        throw new Error('This runner was removed or given a new token')
      }
      this.connections.get(id)?.close()
      this.refusals.delete(id)
      // Named after its host until someone names it.
      this.db.prepare('UPDATE machines SET name = ? WHERE id = ? AND named = 0').run(hello.hostname.split('.')[0] || hello.hostname, id)
      connection = new Connection(id, this.name(id), hello, peer)
      this.connections.set(id, connection)
      this.db.prepare('UPDATE machines SET last_seen = ?, info = ? WHERE id = ?').run(Date.now(), JSON.stringify(hello), id)
      this.events.onChange(id, 'connected')
      return { id, name: connection.name, local: id === LOCAL_MACHINE, chats: this.placement.chatsOn(id) }
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
          const live = new Map(event.sessions.filter((s) => this.placement.owns(id, s.id)).map((s) => [s.id, s]))
          // Unchanged: nothing to tell anyone.
          if (JSON.stringify([...live]) === JSON.stringify([...connection.live])) return
          connection.live = live
        }
        this.events.onEvent(connection, event)
      },
      () => {
        clearTimeout(silent)
        if (!current()) return
        this.connections.delete(id)
        this.db.prepare('UPDATE machines SET last_seen = ? WHERE id = ?').run(Date.now(), id)
        this.events.onChange(id, 'disconnected')
      },
      { replies: RUNNER_REPLIES, timeoutMs: CALL_TIMEOUT_MS },
    )
  }

  /** The connected runner a chat is on, if it's on one. */
  runnerFor(sessionId: string): Connection | undefined {
    const machine = this.placement.machineOf(sessionId)
    return machine ? this.connections.get(machine) : undefined
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
}

/** What a runner on another protocol version is told, and what the UI shows for it. */
export const mismatch = (theirs: unknown) =>
  `The runner speaks protocol v${theirs ?? '?'} and the hub v${RUNNER_PROTOCOL}: update ${Number(theirs) < RUNNER_PROTOCOL ? 'the runner' : 'the hub'}.`

/** What a runner connects with. Only its hash is kept. */
const newToken = () => `badger_${randomBytes(24).toString('base64url')}`

const hash = (token: string) => createHash('sha256').update(token).digest('hex')
