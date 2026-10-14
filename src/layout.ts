import { createSignal } from 'solid-js'
import { api } from './api.ts'

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
 * What a port serves, in a frame; id is the port. Opening it again changes
 * path, and bumps nav, which reloads it.
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

export function addToGroup(tree: Node, groupId: string, view: View, activate = true): Node {
  return mapGroups(tree, (g) =>
    g.id !== groupId ? g : { ...g, views: g.views.some((v) => viewKey(v) === viewKey(view)) ? g.views : [...g.views, view], active: activate ? viewKey(view) : g.active },
  )
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

/** Where a dragged tab was dropped: into a group, or beside a leaf to make a new one. */
export type Drop = { target: string; zone: Edge | 'center' }

export function moveView(tree: Node, key: string, drop: Drop): { tree: Node; group?: string } {
  const from = groupOf(tree, key)
  if (!from) return { tree }
  const view = from.views.find((v) => viewKey(v) === key)!
  if (drop.target === from.id && (drop.zone === 'center' || from.views.length === 1)) return { tree }
  const rest = removeView(tree, key)
  if (drop.zone === 'center') return { tree: addToGroup(rest, drop.target, view), group: drop.target }
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
  /** Where the boundary is, as a fraction of the container along the split's direction. */
  at: number
}

/** Every leaf's rectangle and every boundary between them, as fractions of the container. */
export function measure(tree: Node): { rects: Map<string, Rect>; dividers: Divider[] } {
  const rects = new Map<string, Rect>()
  const dividers: Divider[] = []
  const walk = (n: Node, r: Rect, path: number[]) => {
    if (n.type !== 'split') return void rects.set(leafId(n), r)
    let offset = 0
    n.children.forEach((c, i) => {
      const s = n.sizes[i]
      const child = n.dir === 'row' ? { ...r, x: r.x + offset * r.w, w: s * r.w } : { ...r, y: r.y + offset * r.h, h: s * r.h }
      if (i > 0) dividers.push({ path, index: i, dir: n.dir, split: r, sizes: n.sizes, at: n.dir === 'row' ? child.x : child.y })
      walk(c, child, [...path, i])
      offset += s
    })
  }
  walk(tree, { x: 0, y: 0, w: 1, h: 1 }, [])
  return { rects, dividers }
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

// ── State, per workspace root ──

const KEY = 'badger.layouts'

function load(storage: Storage): Record<string, Layout> | undefined {
  try {
    const raw = storage.getItem(KEY)
    const all = raw ? (JSON.parse(raw) as Record<string, Layout>) : undefined
    // Anything without its chat is from a bug or an older shape; start that one over.
    for (const root in all) if (!leaves(all[root].tree).some((l) => l.type === 'chat')) delete all[root]
    return all
  } catch {
    return undefined
  }
}

// This tab's own layouts survive reloads; a new tab starts from the last one saved anywhere.
const [layouts, setLayouts] = createSignal<Record<string, Layout>>(load(sessionStorage) ?? load(localStorage) ?? {})
localStorage.removeItem('badger.terminalDock')
localStorage.removeItem('badger.terminalDockHeight')

export const layoutOf = (root: string): Layout => layouts()[root] ?? EMPTY

export function updateLayout(root: string, change: (l: Layout) => Layout): void {
  const before = layoutOf(root)
  const after = change(before)
  if (after === before) return
  const next = { ...layouts(), [root]: after }
  setLayouts(next)
  const json = JSON.stringify(next)
  sessionStorage.setItem(KEY, json)
  localStorage.setItem(KEY, json)
}

/** Whether a workspace's panels are on screen. */
export const panelsShown = (root: string) => !layoutOf(root).hidden && groupsOf(layoutOf(root).tree).length > 0

/** Whether a view is on screen: its group's tab showing, with panels shown. */
export function viewShown(root: string, key: string): boolean {
  if (!panelsShown(root)) return false
  const tree = wide() ? layoutOf(root).tree : narrowTree(layoutOf(root))
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
export function placeTerminals(root: string, ids: string[]): void {
  for (const id of ids) pending.delete(id)
  updateLayout(root, (l) => {
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
 * Opens a shell and shows it: in a group, beside a leaf, or by default in
 * the group last worked in (a new panel under the chat if there's none).
 */
export async function openTerminal(root: string, cwd: string, where?: { group: string } | { beside: string; edge: Edge }): Promise<void> {
  let id: string
  try {
    id = (await api.createTerminal({ cwd })).id
  } catch (err) {
    alert(`Couldn't open a terminal: ${err instanceof Error ? err.message : err}`)
    return
  }
  pending.add(id)
  const view: View = { kind: 'terminal', id }
  updateLayout(root, (l) => {
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
export function openView(root: string, view: View): void {
  const key = viewKey(view)
  updateLayout(root, (l) => {
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
export function dropOtherChats(root: string, session: string): void {
  updateLayout(root, (l) => {
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
export function openPreview(root: string, port: number, opts: { name?: string; path?: string } = {}): void {
  updateLayout(root, (l) => {
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

/** Loads a preview again from the path it was opened at. */
export function reloadPreview(root: string, view: PreviewView): void {
  updateLayout(root, (l) => ({ ...l, tree: replaceView(l.tree, { ...view, nav: (view.nav ?? 0) + 1 }) }))
}

/** Show or hide a workspace's panels. Showing with nothing to show opens a shell, like any terminal panel. */
export function togglePanels(root: string, cwd: string): void {
  if (panelsShown(root)) return updateLayout(root, (l) => ({ ...l, hidden: true }))
  const l = layoutOf(root)
  if (!groupsOf(l.tree).length) return void openTerminal(root, cwd)
  updateLayout(root, (l) => ({ ...l, hidden: false }))
  const g = groupsOf(l.tree).find((g) => g.id === l.focus) ?? groupsOf(l.tree)[0]
  setFocusRequest(activeOf(g))
}
