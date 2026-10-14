import { createSignal, type Accessor } from 'solid-js'
import { createStore, reconcile } from 'solid-js/store'
import type { TerminalInfo } from '../shared/protocol.ts'
import { api, socket } from './api.ts'
import { LOCAL } from './machines.ts'

/** Every terminal on the server, kept current over the socket. */
const [list, setList] = createStore<TerminalInfo[]>([])
export const terminals = () => list
/** False until the server has sent the list, so a terminal that isn't in it yet isn't taken for closed. */
const [loaded, setLoaded] = createSignal(false)
export const terminalsLoaded = loaded

socket.on((e) => {
  if (e.type !== 'terminals') return
  setList(reconcile(e.terminals, { key: 'id' }))
  setLoaded(true)
})

/** A workspace: a git root on a machine. Two machines can both have the same path, so the root alone isn't enough. */
export interface Ws {
  machine: string
  root: string
}

/**
 * What a workspace's panels and the like are stored under. The hub's own are
 * keyed by their root alone, as they were before there were other machines.
 */
export const wsKey = (ws: Ws) => (ws.machine === LOCAL ? ws.root : `${ws.machine}:${ws.root}`)

/** The workspace a terminal is in. */
export const terminalWs = (t: TerminalInfo): Ws => ({ machine: t.machine || LOCAL, root: t.root })

export const inWs = (t: TerminalInfo, ws: Ws) => t.root === ws.root && (t.machine || LOCAL) === ws.machine

const roots = new Map<string, Accessor<string | undefined>>()

/** The workspace (git root) a directory on a machine belongs to, as that machine sees it. Terminals are grouped by this. */
/** How long a workspace root that couldn't be looked up stands in as its folder before it's asked for again. */
const RETRY_ROOT_MS = 30 * 1000

export function workspaceOf(machine: string, cwd: string): Accessor<string | undefined> {
  const key = wsKey({ machine, root: cwd })
  let root = roots.get(key)
  if (!root) {
    const [get, set] = createSignal<string>()
    // Not kept for long on failure: the machine may just be offline, and asking again once it's back gets the real root.
    // Not straight away either, or whatever asked would ask again at once, and again.
    api.workspace(cwd, machine).then(
      (r) => set(r.root),
      () => {
        set(cwd)
        setTimeout(() => roots.get(key) === get && roots.delete(key), RETRY_ROOT_MS)
      },
    )
    roots.set(key, (root = get))
  }
  return root
}

/** What a terminal is: the command it runs, else whatever the shell last titled it. */
export const terminalLabel = (t: TerminalInfo) => t.command ?? t.title

/** 'running', or how it ended. */
export function terminalState(t: TerminalInfo): string {
  if (t.running) return 'running'
  if (t.signal) return 'killed'
  return t.exitCode ? `exited ${t.exitCode}` : 'exited'
}
