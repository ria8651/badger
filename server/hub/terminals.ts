import { isAbsolute } from 'node:path'
import type { WebSocket } from 'ws'
import type { TerminalInfo } from '../../shared/protocol.ts'
import { BadRequest } from '../errors.ts'
import type { Connection, Machines } from '../machines.ts'
import type { ChatPlacement } from '../placement.ts'
import type { RunnerEvent } from '../runnerProtocol.ts'
import type { Reply, Request, Route } from './http.ts'
import { debounced, type Viewers } from './viewers.ts'

/** How long opening a terminal waits on its machine for the screen before showing a blank one. */
const SNAPSHOT_TIMEOUT_MS = 10 * 1000
/** Changes to terminals within this long go out to tabs as one, however often runners send them. */
const LIST_DEBOUNCE_MS = 200

/**
 * Every machine's terminals, as browsers see them. A terminal's id in the
 * browser is `<machine>.<id>`: its machine, and its runner's own id there.
 * Tabs viewing a terminal get its screen, then its output as it comes.
 */
export class HubTerminals {
  /** Each connection's terminals with the runner's own ids, once its PTY host has said. A new connection starts unknown. */
  private lists = new WeakMap<Connection, TerminalInfo[]>()
  /**
   * Per terminal, the tabs viewing it and how many views each has open. A tab
   * isn't live until its snapshot goes out: output before then is already in
   * the snapshot.
   */
  private viewing = new Map<string, Map<WebSocket, { views: number; live: boolean }>>()

  constructor(
    private machines: Machines,
    private placement: ChatPlacement,
    private viewers: Viewers,
  ) {}

  /** Every terminal on every connected machine; undefined until each one's PTY host has said, as the list is unknown, not empty. */
  list(): TerminalInfo[] | undefined {
    const online = this.machines.online()
    if (!online.every((c) => this.lists.has(c))) return undefined
    return online.flatMap((c) => this.lists.get(c)!.map((t) => this.global(c, t)))
  }

  /** Tells every tab the list, once they've stopped changing for a moment. */
  readonly changed = debounced(() => {
    const list = this.list()
    if (!list) return
    this.viewers.toAll({ type: 'terminals', terminals: list })
    // An offline machine's terminals aren't listed but haven't closed: their viewers pick up again when it's back.
    for (const id of this.viewing.keys()) if (this.find(id) && !list.some((t) => t.id === id)) this.viewing.delete(id)
  }, LIST_DEBOUNCE_MS)

  runnerEvent(c: Connection, event: Extract<RunnerEvent, { type: 'terminals' | 'term_output' }>): void {
    if (event.type === 'terminals') {
      this.lists.set(c, event.terminals.map((t) => this.own(c, t)))
      return this.changed()
    }
    const id = globalId(c.id, event.id)
    for (const [ws, v] of this.viewing.get(id) ?? []) if (v.live) this.viewers.send(ws, { type: 'term_output', id, data: event.data })
  }

  /** A machine's runner connected or went. Back, its terminals' viewers start again from a snapshot. */
  machineChanged(machine: string, online: boolean): void {
    this.changed()
    if (!online) return
    for (const [id, set] of this.viewing) {
      if (!id.startsWith(`${machine}.`)) continue
      for (const [ws, v] of set) {
        v.live = false
        this.snapshot(ws, id)
      }
    }
  }

  /** Every subscribe gets a fresh snapshot, which also resets any view of it the tab already has. */
  subscribe(ws: WebSocket, id: string): void {
    let set = this.viewing.get(id)
    if (!set) this.viewing.set(id, (set = new Map()))
    const v = set.get(ws) ?? { views: 0, live: false }
    set.set(ws, { views: v.views + 1, live: false })
    this.snapshot(ws, id)
  }

  unsubscribe(ws: WebSocket, id: string): void {
    const set = this.viewing.get(id)
    const v = set?.get(ws)
    if (v && --v.views <= 0) set!.delete(ws)
  }

  /** A tab closed. */
  drop(ws: WebSocket): void {
    for (const set of this.viewing.values()) set.delete(ws)
  }

  input(id: string, data: string): void {
    const t = this.find(id)
    t?.runner.termInput(t.id, data)
  }

  resize(id: string, cols: number, rows: number): void {
    const t = this.find(id)
    t?.runner.termResize(t.id, cols, rows)
  }

  /** The one-off actions; live I/O goes over the WebSocket. */
  routes(): Route[] {
    const ID = /^\/api\/terminals\/([a-z0-9-]+\.[0-9a-f]+)$/
    // A terminal its runner has listed; anything else is a 404.
    const listed =
      (fn: (t: { runner: Connection; id: string }, req: Request) => Promise<Reply>): Route[2] =>
      (req) => {
        const t = this.find(req.params[0])
        if (!t || !this.lists.get(t.runner)?.some((x) => x.id === t.id)) return [404, { error: 'No such terminal' }]
        return fn(t, req)
      }
    return [
      ['GET', '/api/terminals', () => [200, this.list() ?? []]],
      [
        'POST',
        '/api/terminals',
        async (req) => {
          const { cwd, command, cols, rows, machine } = await req.json()
          if (typeof cwd !== 'string' || !isAbsolute(cwd)) throw new BadRequest('cwd must be an absolute path')
          if (command !== undefined && typeof command !== 'string') throw new BadRequest('command must be a string')
          const c = this.machines.fromRequest(machine)
          return [201, this.upsert(c, await c.remote.termCreate({ cwd, command: command || undefined, cols, rows }))]
        },
      ],
      [
        'POST',
        /^\/api\/terminals\/([a-z0-9-]+\.[0-9a-f]+)\/restart$/,
        listed(async (t) => [200, this.upsert(t.runner, await t.runner.remote.termRestart(t.id))]),
      ],
      [
        'PATCH',
        ID,
        listed(async (t, req) => {
          const { name } = await req.json()
          if (name !== undefined && typeof name !== 'string') throw new BadRequest('name must be a string')
          return [200, this.upsert(t.runner, await t.runner.remote.termRename(t.id, name || undefined))]
        }),
      ],
      [
        'DELETE',
        ID,
        listed(async (t) => {
          await t.runner.remote.termRemove(t.id)
          const list = this.lists.get(t.runner)
          if (list) this.lists.set(t.runner, list.filter((x) => x.id !== t.id))
          return [204, null]
        }),
      ],
    ]
  }

  /** The reply is handled in order with the terminal's output, so nothing falls between the snapshot and going live. */
  private snapshot(ws: WebSocket, id: string): void {
    const done = (data: string | undefined) => {
      const current = this.viewing.get(id)?.get(ws)
      if (!current || current.live) return
      current.live = true
      this.viewers.send(ws, { type: 'term_snapshot', id, data: data ?? '' })
    }
    const t = this.find(id)
    if (!t) return done(undefined)
    t.runner.termSnapshot(t.id, SNAPSHOT_TIMEOUT_MS, (err, data) => done(err ? undefined : data))
  }

  /** A browser's terminal id, as its machine's connected runner and its id there. */
  private find(id: string): { runner: Connection; id: string } | undefined {
    const dot = id.lastIndexOf('.')
    const runner = dot > 0 ? this.machines.get(id.slice(0, dot)) : undefined
    return runner && { runner, id: id.slice(dot + 1) }
  }

  /**
   * Takes a terminal a runner just created or restarted into its list. The
   * runner's own list broadcasts are throttled; this way the browser can open
   * it straight away. Returns it as the browser sees it.
   */
  private upsert(c: Connection, reply: TerminalInfo): TerminalInfo {
    const info = this.own(c, reply)
    const list = this.lists.get(c) ?? []
    const i = list.findIndex((t) => t.id === info.id)
    this.lists.set(c, i < 0 ? [...list, info] : list.with(i, info))
    return this.global(c, info)
  }

  /** A terminal says which chat started it; only one of its own machine's. */
  private own(c: Connection, t: TerminalInfo): TerminalInfo {
    return t.sessionId && !this.placement.owns(c.id, t.sessionId) ? { ...t, sessionId: undefined } : t
  }

  private global(c: Connection, t: TerminalInfo): TerminalInfo {
    return { ...t, id: globalId(c.id, t.id), machine: c.id }
  }
}

export const globalId = (machine: string, id: string) => `${machine}.${id}`
