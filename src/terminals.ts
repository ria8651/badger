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

/**
 * Runners seen offline whose terminals haven't been listed since. One that's
 * back is online before the hub has its terminals, and they'd look closed.
 */
const [unlisted, setUnlisted] = createSignal<ReadonlySet<string>>(new Set())
let online = new Set<string>()

socket.on((e) => {
  if (e.type === 'machines') {
    const back = e.machines.filter((m) => m.online && !online.has(m.id))
    online = new Set(e.machines.filter((m) => m.online).map((m) => m.id))
    for (const m of back) retryRoots(m.id)
    const offline = e.machines.filter((m) => !m.online && !unlisted().has(m.id))
    if (offline.length) setUnlisted(new Set([...unlisted(), ...offline.map((m) => m.id)]))
  }
  if (e.type !== 'terminals') return
  setList(reconcile(e.terminals, { key: 'id' }))
  setLoaded(true)
  // The hub only sends the list once every runner connected to it has said what it has. One whose
  // terminals are in it was connected whatever the last machine list said.
  const listed = new Set(e.terminals.map((t) => t.machine || LOCAL))
  if ([...unlisted()].some((m) => online.has(m) || listed.has(m))) setUnlisted(new Set([...unlisted()].filter((m) => !online.has(m) && !listed.has(m))))
})

/** Whether a machine's terminals are all in the list, so one missing from it has closed. */
export const terminalsListed = (machine: string) => loaded() && !unlisted().has(machine)

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

const roots = new Map<string, { get: Accessor<string | undefined>; set: (root: string) => void }>()

/** How long a workspace root that couldn't be looked up stands in as its folder before it's asked for again; doubling each time. */
const RETRY_ROOT_MS = 30 * 1000
const RETRY_ROOT_MAX_MS = 10 * 60 * 1000
/** Lookups that failed, by key, with the machine they're on: each asks again, now. */
const retries = new Map<string, { machine: string; again: () => void }>()

/** Asks again for every root that couldn't be looked up, or just those on one machine. */
function retryRoots(machine?: string) {
  for (const [key, r] of [...retries]) if (!machine || r.machine === machine) (retries.delete(key), r.again())
}
// Whatever failed while the hub or a runner was out of reach is worth asking again as soon as it's back.
socket.onConnection((connected) => connected && retryRoots())

/**
 * Roots the server already knows, e.g. from the chat list, so a chat's workspace is there the moment it opens.
 * One being looked up, or standing in as its folder, gets the real one.
 */
export function knowRoots(known: { machine: string; cwd: string; root: string }[]): void {
  for (const { machine, cwd, root } of known) {
    const key = wsKey({ machine, root: cwd })
    const found = roots.get(key)
    if (found) {
      if (found.get() !== root) (retries.delete(key), found.set(root))
    } else {
      const [get, set] = createSignal<string | undefined>(root)
      roots.set(key, { get, set })
    }
  }
}

/** A folder's workspace if it's already known, without asking: e.g. for a machine that's offline. */
export const knownRoot = (machine: string, cwd: string) => roots.get(wsKey({ machine, root: cwd }))?.get()

/**
 * The workspace (git root) a directory on a machine belongs to, as that machine sees it. Terminals are grouped by this.
 * Known at once for any chat's folder in the chat list; others are looked up. Until then the directory stands in
 * for it; it's asked for again in the background, and when the hub or the machine comes back, and the same accessor
 * gets the real one.
 */
export function workspaceOf(machine: string, cwd: string): Accessor<string | undefined> {
  const key = wsKey({ machine, root: cwd })
  let found = roots.get(key)
  if (!found) {
    const [get, set] = createSignal<string>()
    let wait = RETRY_ROOT_MS
    let timer: ReturnType<typeof setTimeout> | undefined
    const ask = () => {
      clearTimeout(timer)
      api.workspace(cwd, machine).then(
        (r) => set(r.root),
        () => {
          set((last) => last ?? cwd)
          retries.set(key, { machine, again: ask })
          timer = setTimeout(() => retries.get(key)?.again === ask && (retries.delete(key), ask()), wait)
          wait = Math.min(wait * 2, RETRY_ROOT_MAX_MS)
        },
      )
    }
    ask()
    roots.set(key, (found = { get, set }))
  }
  return found.get
}

/** What a terminal is called: its name, else the command it runs, else (from older hosts) whatever the shell last titled it. */
export const terminalLabel = (t: TerminalInfo) => t.name ?? t.command ?? t.title

/** For a tooltip: its label, and the command too when a name stands in for it. */
export const terminalTooltip = (t: TerminalInfo) => [terminalLabel(t), t.name && t.command && `$ ${t.command}`].filter(Boolean).join('\n')

/** 'running', or how it ended. */
export function terminalState(t: TerminalInfo): string {
  if (t.running) return 'running'
  if (t.signal) return 'killed'
  return t.exitCode ? `exited ${t.exitCode}` : 'exited'
}
