import { createSignal } from 'solid-js'
import { api } from './api.ts'
import { showError } from './components/Popover.tsx'
import { LOCAL } from './machines.ts'
import { wsKey, type Ws } from './terminals.ts'

/**
 * The panels around a chat. The chat is a fixed leaf of a split tree; the
 * other leaves are tab groups of views. Laid out per workspace, so every chat
 * in one sees the same panels, and per browser tab, so two tabs can differ.
 */

/**
 * Something a panel shows: a terminal, a port's preview, a subagent or
 * background task of a chat, by the tool call that started it, or a chat's
 * plan. Tasks and plans are their chat's own, so they only show beside it.
 */
export type View = { kind: 'terminal'; id: string } | PreviewView | { kind: 'task'; session: string; id: string } | PlanView
/**
 * What a port serves, in a frame; id is the port. Path is where the page is:
 * where it was opened, then wherever it's gone since. Opening it again
 * changes path, and bumps nav, which reloads it.
 */
export type PreviewView = { kind: 'preview'; id: string; name?: string; path?: string; nav?: number }
/** The plan a chat is proposing, or last proposed. One per chat, so a revised plan takes the old one's place. */
export type PlanView = { kind: 'plan'; session: string }
export const planView = (session: string): PlanView => ({ kind: 'plan', session })
export const viewKey = (v: View) =>
  v.kind === 'task' ? `task:${v.session}:${v.id}` : v.kind === 'plan' ? `plan:${v.session}` : `${v.kind}:${v.id}`
/** The chat a view belongs to, if it only shows beside one. */
export const sessionOf = (v: View) => (v.kind === 'task' || v.kind === 'plan' ? v.session : undefined)

export type Group = { type: 'group'; id: string; views: View[]; active?: string }
export type Leaf = { type: 'chat' } | Group
export type Split = { type: 'split'; dir: 'row' | 'col'; children: Node[]; sizes: number[] }
export type Node = Leaf | Split

export interface Layout {
  tree: Node
  /** Panels put away; the tree is kept for when they come back. */
  hidden: boolean
  /** The group last worked in, where new views go. */
  focus?: string
  /** On narrow screens every panel shares one group under the chat: its share of the height. */
  narrow?: number
}

const wideQuery = matchMedia('(min-width: 768px)')
const [wide, setWide] = createSignal(wideQuery.matches)
wideQuery.addEventListener('change', (e) => setWide(e.matches))
/** Wide enough to tile panels; narrower, they share one group under the chat. */
export { wide }

const mac = /Mac|iPhone|iPad/.test(navigator.userAgent)
/** The chord every layout shortcut starts with: Cmd+K on a Mac, Ctrl+K elsewhere. */
export const LEADER = mac ? '⌘K' : 'Ctrl+K'
export const isLeader = (e: KeyboardEvent) =>
  e.key.toLowerCase() === 'k' && (mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey) && !e.altKey && !e.shiftKey

export type Edge = 'left' | 'right' | 'top' | 'bottom'
export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** A length on screen: a fraction of the container plus a number of gutters, the theme's space between panes. */
export interface Len {
  f: number
  g: number
}
/** Where a pane or gutter is drawn, gutters included; Rect leaves them out. */
export interface Box {
  x: Len
  y: Len
  w: Len
  h: Len
}
const len = (f: number, g = 0): Len => ({ f, g })
const plus = (a: Len, b: Len): Len => ({ f: a.f + b.f, g: a.g + b.g })
const times = (a: Len, k: number): Len => ({ f: a.f * k, g: a.g * k })

/** A share of a box, from `from` to `to` along x or y, as fractions of it. */
export function part(b: Box, dir: 'row' | 'col', from: number, to: number): Box {
  return dir === 'row' ? { ...b, x: plus(b.x, times(b.w, from)), w: times(b.w, to - from) } : { ...b, y: plus(b.y, times(b.h, from)), h: times(b.h, to - from) }
}

export const CHAT: Leaf = { type: 'chat' }
const EMPTY: Layout = { tree: CHAT, hidden: true }

let counter = 0
const newGroupId = () => `g${Date.now().toString(36)}${(counter++).toString(36)}`

export const leafId = (n: Leaf) => (n.type === 'chat' ? 'chat' : n.id)
export const leaves = (n: Node): Leaf[] => (n.type === 'split' ? n.children.flatMap(leaves) : [n])
export const groupsOf = (n: Node) => leaves(n).filter((l): l is Group => l.type === 'group')
export const groupOf = (n: Node, key: string) => groupsOf(n).find((g) => g.views.some((v) => viewKey(v) === key))
export const viewsOf = (n: Node) => groupsOf(n).flatMap((g) => g.views)
/** The tab showing: the one picked, if it's still there, else the first. */
export const activeOf = (g: Group) => (g.views.some((v) => viewKey(v) === g.active) ? g.active! : viewKey(g.views[0]))

function mapGroups(n: Node, f: (g: Group) => Group): Node {
  if (n.type === 'split') return { ...n, children: n.children.map((c) => mapGroups(c, f)) }
  return n.type === 'group' ? f(n) : n
}

/** Drops empty groups, unwraps splits left with one child and folds splits into a parent going the same way. */
function normalize(n: Node): Node {
  if (n.type !== 'split') return n
  const children: Node[] = []
  const sizes: number[] = []
  n.children.forEach((c, i) => {
    const k = normalize(c)
    if (k.type === 'group' && !k.views.length) return
    if (k.type === 'split' && k.dir === n.dir) {
      k.children.forEach((g, j) => (children.push(g), sizes.push(n.sizes[i] * k.sizes[j])))
    } else {
      children.push(k)
      sizes.push(n.sizes[i])
    }
  })
  if (!children.length) return { type: 'group', id: '', views: [] }
  if (children.length === 1) return children[0]
  const total = sizes.reduce((a, b) => a + b, 0)
  return { ...n, children, sizes: sizes.map((s) => s / total) }
}

export function removeView(tree: Node, key: string): Node {
  return normalize(mapGroups(tree, (g) => (g.views.some((v) => viewKey(v) === key) ? { ...g, views: g.views.filter((v) => viewKey(v) !== key) } : g)))
}

/** Adds a view to a group, at the end or before the tab at `index`; one already there only moves if given an index. */
export function addToGroup(tree: Node, groupId: string, view: View, activate = true, index?: number): Node {
  const key = viewKey(view)
  return mapGroups(tree, (g) => {
    if (g.id !== groupId) return g
    const i = g.views.findIndex((v) => viewKey(v) === key)
    if (i >= 0 && index === undefined) return { ...g, active: activate ? key : g.active }
    const views = g.views.filter((v) => viewKey(v) !== key)
    // The index counts the tab itself, if it was here: past it, that's one less.
    const at = index === undefined ? views.length : Math.min(i >= 0 && index > i ? index - 1 : index, views.length)
    views.splice(at, 0, i >= 0 ? g.views[i] : view)
    return { ...g, views, active: activate ? key : g.active }
  })
}

function replaceView(tree: Node, view: View): Node {
  return mapGroups(tree, (g) => ({ ...g, views: g.views.map((v) => (viewKey(v) === viewKey(view) ? view : v)) }))
}

export function setActive(tree: Node, key: string): Node {
  return mapGroups(tree, (g) => (g.views.some((v) => viewKey(v) === key) ? { ...g, active: key } : g))
}

/** Puts a leaf beside another (the chat or a group), taking `share` of that one's room. */
function insertBeside(tree: Node, target: string, edge: Edge, leaf: Leaf, share: number): Node {
  const dir = edge === 'left' || edge === 'right' ? 'row' : 'col'
  const after = edge === 'right' || edge === 'bottom'
  const go = (n: Node): Node => {
    if (n.type === 'split') {
      const i = n.children.findIndex((c) => c.type !== 'split' && leafId(c) === target)
      if (i >= 0 && n.dir === dir) {
        const children = [...n.children]
        const sizes = [...n.sizes]
        const part = sizes[i] * share
        sizes[i] -= part
        children.splice(after ? i + 1 : i, 0, leaf)
        sizes.splice(after ? i + 1 : i, 0, part)
        return { ...n, children, sizes }
      }
      return { ...n, children: n.children.map(go) }
    }
    if (leafId(n) !== target) return n
    return { type: 'split', dir, children: after ? [n, leaf] : [leaf, n], sizes: after ? [1 - share, share] : [share, 1 - share] }
  }
  return normalize(go(tree))
}

/** A new group of these views beside the target. Next to the chat it takes less, so the chat stays the main thing. */
export function splitWith(tree: Node, target: string, edge: Edge, views: View[]): { tree: Node; group: string } {
  const group: Group = { type: 'group', id: newGroupId(), views, active: viewKey(views[0]) }
  return { tree: insertBeside(tree, target, edge, group, target === 'chat' ? 0.4 : 0.5), group: group.id }
}

/** Where a dragged tab was dropped: into a group, before its tab at `index` if on its tab bar, or beside a leaf to make a new one. */
export type Drop = { target: string; zone: Edge | 'center'; index?: number }

export function moveView(tree: Node, key: string, drop: Drop): { tree: Node; group?: string } {
  const from = groupOf(tree, key)
  if (!from) return { tree }
  const view = from.views.find((v) => viewKey(v) === key)!
  if (drop.target === from.id && drop.zone === 'center') return { tree: addToGroup(tree, from.id, view, true, drop.index), group: from.id }
  if (drop.target === from.id && from.views.length === 1) return { tree }
  const rest = removeView(tree, key)
  if (drop.zone === 'center') return { tree: addToGroup(rest, drop.target, view, true, drop.index), group: drop.target }
  return splitWith(rest, drop.target, drop.zone, [view])
}

export function setSizes(tree: Node, path: number[], sizes: number[]): Node {
  if (tree.type !== 'split') return tree
  if (!path.length) return { ...tree, sizes }
  const [i, ...rest] = path
  return { ...tree, children: tree.children.map((c, j) => (j === i ? setSizes(c, rest, sizes) : c)) }
}

export interface Divider {
  /** Child indexes from the root to the split. */
  path: number[]
  /** The boundary is before this child. */
  index: number
  dir: 'row' | 'col'
  /** The whole split, so a drag can be turned into its sizes. */
  split: Rect
  sizes: number[]
  /** The room the split's children share along its direction: the split less its gutters. */
  room: Len
  /** Where the boundary is, as a fraction of the container along the split's direction. */
  at: number
  /** The gutter itself, which is what's dragged. */
  gutter: Box
}

/** Where a vertical and a horizontal gutter meet, for dragging both at once. */
export interface Junction {
  /** The gutter between side-by-side panes. */
  vertical: Divider
  /** The gutter between stacked ones. */
  horizontal: Divider
}

/**
 * Every leaf's rectangle and every boundary between them. Rects are fractions
 * of the container, for finding panes; boxes are where they're drawn, with a
 * gutter between each pair of siblings.
 */
export function measure(tree: Node): { rects: Map<string, Rect>; boxes: Map<string, Box>; dividers: Divider[]; junctions: Junction[] } {
  const rects = new Map<string, Rect>()
  const boxes = new Map<string, Box>()
  const dividers: Divider[] = []
  const walk = (n: Node, r: Rect, b: Box, path: number[]) => {
    if (n.type !== 'split') {
      rects.set(leafId(n), r)
      boxes.set(leafId(n), b)
      return
    }
    const row = n.dir === 'row'
    const start = row ? b.x : b.y
    const room = plus(row ? b.w : b.h, len(0, 1 - n.children.length))
    let offset = 0
    n.children.forEach((c, i) => {
      const s = n.sizes[i]
      const child = row ? { ...r, x: r.x + offset * r.w, w: s * r.w } : { ...r, y: r.y + offset * r.h, h: s * r.h }
      const from = plus(plus(start, times(room, offset)), len(0, i))
      const size = times(room, s)
      const box = row ? { ...b, x: from, w: size } : { ...b, y: from, h: size }
      if (i > 0) {
        const at = plus(from, len(0, -1))
        const gutter = row ? { ...b, x: at, w: len(0, 1) } : { ...b, y: at, h: len(0, 1) }
        dividers.push({ path, index: i, dir: n.dir, split: r, sizes: n.sizes, room, at: row ? child.x : child.y, gutter })
      }
      walk(c, child, box, [...path, i])
      offset += s
    })
  }
  walk(tree, { x: 0, y: 0, w: 1, h: 1 }, { x: len(0), y: len(0), w: len(1), h: len(1) }, [])

  // A horizontal gutter meets a vertical one where each reaches the other's line, ends included.
  const e = 1e-6
  const junctions: Junction[] = []
  for (const vertical of dividers.filter((d) => d.dir === 'row'))
    for (const horizontal of dividers.filter((d) => d.dir === 'col'))
      if (
        horizontal.at >= vertical.split.y - e &&
        horizontal.at <= vertical.split.y + vertical.split.h + e &&
        vertical.at >= horizontal.split.x - e &&
        vertical.at <= horizontal.split.x + horizontal.split.w + e
      )
        junctions.push({ vertical, horizontal })
  return { rects, boxes, dividers, junctions }
}

/** On narrow screens: the chat, and under it one group holding every view, showing the focused group's tab. */
export function narrowTree(l: Layout): Node {
  const groups = groupsOf(l.tree)
  const main = groups.find((g) => g.id === l.focus) ?? groups[0]
  if (!main) return CHAT
  const merged: Group = { type: 'group', id: main.id, views: groups.flatMap((g) => g.views), active: activeOf(main) }
  const share = l.narrow ?? 0.45
  return { type: 'split', dir: 'col', children: [CHAT, merged], sizes: [1 - share, share] }
}

// ── State, per workspace: a root on a machine ──

const KEY = 'badger.layouts'

/** A terminal view with the machine in its id, as the browser's ids are now: `<machine>.<id>`. */
function withMachine(g: Group): Group {
  if (!g.views.some((v) => v.kind === 'terminal' && !v.id.includes('.'))) return g
  const fix = (key: string) => (key.startsWith('terminal:') && !key.includes('.') ? `terminal:${LOCAL}.${key.slice('terminal:'.length)}` : key)
  const views = g.views.map((v): View => (v.kind === 'terminal' && !v.id.includes('.') ? { ...v, id: `${LOCAL}.${v.id}` } : v))
  return { ...g, views, active: g.active && fix(g.active) }
}

function load(storage: Storage): Record<string, Layout> | undefined {
  try {
    const raw = storage.getItem(KEY)
    const all = raw ? (JSON.parse(raw) as Record<string, Layout>) : undefined
    // Anything without its chat is from a bug or an older shape; start that one over.
    for (const root in all) if (!leaves(all[root].tree).some((l) => l.type === 'chat')) delete all[root]
    // Saved before there were other machines, terminals were their bare ids; those are all the hub's own.
    for (const root in all) all[root] = { ...all[root], tree: mapGroups(all[root].tree, withMachine) }
    return all
  } catch {
    return undefined
  }
}

// This tab's own layouts survive reloads; a new tab starts from the last one saved anywhere.
const [layouts, setLayouts] = createSignal<Record<string, Layout>>(load(sessionStorage) ?? load(localStorage) ?? {})
localStorage.removeItem('badger.terminalDock')
localStorage.removeItem('badger.terminalDockHeight')

export const layoutOf = (ws: Ws): Layout => layouts()[wsKey(ws)] ?? EMPTY

export function updateLayout(ws: Ws, change: (l: Layout) => Layout): void {
  const before = layoutOf(ws)
  const after = change(before)
  if (after === before) return
  const next = { ...layouts(), [wsKey(ws)]: after }
  setLayouts(next)
  const json = JSON.stringify(next)
  sessionStorage.setItem(KEY, json)
  localStorage.setItem(KEY, json)
}

/** Whether a workspace's panels are on screen. */
export const panelsShown = (ws: Ws) => !layoutOf(ws).hidden && groupsOf(layoutOf(ws).tree).length > 0

/** Whether a view is on screen: its group's tab showing, with panels shown. */
export function viewShown(ws: Ws, key: string): boolean {
  if (!panelsShown(ws)) return false
  const tree = wide() ? layoutOf(ws).tree : narrowTree(layoutOf(ws))
  return groupsOf(tree).some((g) => activeOf(g) === key)
}

/** The view to focus once it's on screen, e.g. a terminal just opened. */
const [focusRequest, setFocusRequest] = createSignal<string | undefined>(undefined, { equals: false })
export { focusRequest, setFocusRequest }

/** Terminals asked for here but not yet in the server's list, so they aren't taken for closed. */
const pending = new Set<string>()

/**
 * Keeps a workspace's terminals and its panels in step: closed ones leave,
 * and new ones join the group last worked in, or a new panel under the chat.
 * New ones don't show hidden panels; whoever opened them can.
 */
export function placeTerminals(ws: Ws, ids: string[]): void {
  for (const id of ids) pending.delete(id)
  updateLayout(ws, (l) => {
    const live = new Set(ids)
    let tree = l.tree
    for (const v of viewsOf(tree)) if (v.kind === 'terminal' && !live.has(v.id) && !pending.has(v.id)) tree = removeView(tree, viewKey(v))
    const placed = new Set(viewsOf(tree).map(viewKey))
    const missing = ids.filter((id) => !placed.has(`terminal:${id}`)).map((id): View => ({ kind: 'terminal', id }))
    if (missing.length) {
      const groups = groupsOf(tree)
      const target = groups.find((g) => g.id === l.focus) ?? groups[0]
      if (target) for (const v of missing) tree = addToGroup(tree, target.id, v, false)
      else tree = splitWith(tree, 'chat', 'bottom', missing).tree
    }
    if (tree === l.tree) return l
    return { ...l, tree, hidden: l.hidden || !groupsOf(tree).length }
  })
}

/**
 * Opens a shell, or runs `command`, and shows it: in a group, beside a leaf,
 * or by default in the group last worked in (a new panel under the chat if there's none).
 */
export async function openTerminal(ws: Ws, cwd: string, where?: { group: string } | { beside: string; edge: Edge }, command?: string): Promise<void> {
  let id: string
  try {
    id = (await api.createTerminal({ cwd, machine: ws.machine, command })).id
  } catch (err) {
    showError("Couldn't open a terminal", err instanceof Error ? err.message : String(err))
    return
  }
  pending.add(id)
  const view: View = { kind: 'terminal', id }
  updateLayout(ws, (l) => {
    // The server's list may have got here first and placed it already.
    const tree = removeView(l.tree, viewKey(view))
    const groups = groupsOf(tree)
    const into = where && 'group' in where ? where.group : !where ? (groups.find((g) => g.id === l.focus) ?? groups[0])?.id : undefined
    if (into && groups.some((g) => g.id === into)) return { ...l, tree: addToGroup(tree, into, view), focus: into, hidden: false }
    const placed = where && 'beside' in where ? splitWith(tree, where.beside, where.edge, [view]) : splitWith(tree, 'chat', 'bottom', [view])
    return { ...l, tree: placed.tree, focus: placed.group, hidden: false }
  })
  setFocusRequest(viewKey(view))
}

/**
/**
 * Shows a view that needs nothing started, e.g. a task: where it already is,
 * else in the group last worked in, else in a new panel beside the chat.
 */
export function openView(ws: Ws, view: View): void {
  const key = viewKey(view)
  updateLayout(ws, (l) => {
    const at = groupOf(l.tree, key)
    if (at) return { ...l, tree: setActive(l.tree, key), focus: at.id, hidden: false }
    const groups = groupsOf(l.tree)
    const into = groups.find((g) => g.id === l.focus) ?? groups[0]
    if (into) return { ...l, tree: addToGroup(l.tree, into.id, view), focus: into.id, hidden: false }
    const placed = splitWith(l.tree, 'chat', 'right', [view])
    return { ...l, tree: placed.tree, focus: placed.group, hidden: false }
  })
  setFocusRequest(key)
}

/** Takes other chats' tasks and plans out of a workspace's panels: they only show beside their own chat. */
export function dropOtherChats(ws: Ws, session: string): void {
  updateLayout(ws, (l) => {
    let tree = l.tree
    for (const v of viewsOf(tree)) if (sessionOf(v) && sessionOf(v) !== session) tree = removeView(tree, viewKey(v))
    return tree === l.tree ? l : { ...l, tree }
  })
}

/**
 * Shows a port's preview: the tab it already has, navigated and reloaded, or
 * a new one with the other previews, else in a new panel right of the chat,
 * where a page gets the width it needs. Shows hidden panels: asking for a
 * preview is asking to see it.
 */
export function openPreview(ws: Ws, port: number, opts: { name?: string; path?: string } = {}): void {
  updateLayout(ws, (l) => {
    const id = String(port)
    const found = viewsOf(l.tree).find((v): v is PreviewView => v.kind === 'preview' && v.id === id)
    if (found) {
      const view: PreviewView = { ...found, name: opts.name ?? found.name, path: opts.path ?? found.path, nav: (found.nav ?? 0) + 1 }
      return { ...l, tree: setActive(replaceView(l.tree, view), viewKey(view)), hidden: false }
    }
    const view: View = { kind: 'preview', id, name: opts.name, path: opts.path }
    const into = groupsOf(l.tree).find((g) => g.views.some((v) => v.kind === 'preview'))
    if (into) return { ...l, tree: addToGroup(l.tree, into.id, view), hidden: false }
    // Focus stays where it was, so new terminals still go with the others.
    return { ...l, tree: splitWith(l.tree, 'chat', 'right', [view]).tree, hidden: false }
  })
}

/** Notes where a preview's page has gone, without reloading it, so a reload comes back there. */
export function movePreview(ws: Ws, port: string, path: string): void {
  updateLayout(ws, (l) => {
    const found = viewsOf(l.tree).find((v): v is PreviewView => v.kind === 'preview' && v.id === port)
    return !found || found.path === path ? l : { ...l, tree: replaceView(l.tree, { ...found, path }) }
  })
}

/** Loads a preview again, wherever its page last was. */
export function reloadPreview(ws: Ws, view: PreviewView): void {
  updateLayout(ws, (l) => ({ ...l, tree: replaceView(l.tree, { ...view, nav: (view.nav ?? 0) + 1 }) }))
}

/** Show or hide a workspace's panels. Showing with nothing to show opens a shell, like any terminal panel. */
export function togglePanels(ws: Ws, cwd: string): void {
  if (panelsShown(ws)) return updateLayout(ws, (l) => ({ ...l, hidden: true }))
  const l = layoutOf(ws)
  if (!groupsOf(l.tree).length) return void openTerminal(ws, cwd)
  updateLayout(ws, (l) => ({ ...l, hidden: false }))
  const g = groupsOf(l.tree).find((g) => g.id === l.focus) ?? groupsOf(l.tree)[0]
  setFocusRequest(activeOf(g))
}
