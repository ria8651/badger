import { createSignal, type Accessor } from 'solid-js'
import { createStore, reconcile } from 'solid-js/store'
import type { TerminalInfo } from '../shared/protocol.ts'
import { api, socket } from './api.ts'

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

const roots = new Map<string, Accessor<string | undefined>>()

/** The workspace (git root) a directory belongs to, as the server sees it. Terminals are grouped by this. */
export function workspaceOf(cwd: string): Accessor<string | undefined> {
  let root = roots.get(cwd)
  if (!root) {
    const [get, set] = createSignal<string>()
    api.workspace(cwd).then((r) => set(r.root), () => set(cwd))
    roots.set(cwd, (root = get))
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

// ── Dock state, per workspace, kept across chats and reloads ──

interface DockState {
  open: boolean
  active?: string
}

const DOCK_KEY = 'badger.terminalDock'
const HEIGHT_KEY = 'badger.terminalDockHeight'

const [docks, setDocks] = createStore<Record<string, DockState>>(load(DOCK_KEY, {}))
const [height, setHeightSignal] = createSignal<number>(load(HEIGHT_KEY, 300))

export const dockState = (root: string): DockState => docks[root] ?? { open: false }
export const dockHeight = height

export function setDock(root: string, patch: Partial<DockState>): void {
  setDocks(root, (d) => ({ ...(d ?? { open: false }), ...patch }))
  localStorage.setItem(DOCK_KEY, JSON.stringify(docks))
}

export function setDockHeight(px: number): void {
  setHeightSignal(px)
  localStorage.setItem(HEIGHT_KEY, String(px))
}

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}
