import { createSignal } from 'solid-js'
import { api } from './api.ts'
import { LOCAL } from './machines.ts'
import { wsKey, type Ws } from './terminals.ts'

/**
 * The panels around a chat. The chat is a fixed leaf of a split tree; the
 * other leaves are tab groups of views. Laid out per workspace, so every chat
 * in one sees the same panels, and per browser tab, so two tabs can differ.
 */

/**
 * Something a panel shows: a terminal, a port's preview, a subagent or
 * background task of a chat, by the tool call that started it, a chat's
 * plan, something sent with one of its prompts, or its side chats. Tasks,
 * plans, attachments and side chats are their chat's own, so they only show
 * beside it.
 */
export type View =
  | { kind: 'terminal'; id: string }
  | PreviewView
  | { kind: 'task'; session: string; id: string }
  | PlanView
  | ReviewView
  | AttachmentView
  | BtwView
/**
 * What a port serves, in a frame; id is the port. Path is where the page is:
 * where it was opened, then wherever it's gone since. Opening it again
 * changes path, and bumps nav, which reloads it.
 */
export type PreviewView = { kind: 'preview'; id: string; name?: string; path?: string; nav?: number }
/** The plan a chat is proposing, or last proposed. One per chat, so a revised plan takes the old one's place. */
export type PlanView = { kind: 'plan'; session: string }
export const planView = (session: string): PlanView => ({ kind: 'plan', session })
/** The changes in a chat's checkout, to read and comment on. One per chat, since comments go back to it. */
export type ReviewView = { kind: 'review'; session: string }
export const reviewView = (session: string): ReviewView => ({ kind: 'review', session })
/**
 * Something that went in with a prompt, e.g. a paste or a memory file. By reference: the prompt's message
 * and which `part` of it (`paste:<n>` or `context:<n>`), so layouts don't keep copies of what can be big.
 */
export type AttachmentView = { kind: 'attachment'; session: string; prompt: string; part: string }
/** A chat's side chats (/btw), one panel for them all. Which it shows is kept per browser tab, in btw.ts. */
export type BtwView = { kind: 'btw'; session: string }
export const btwView = (session: string): BtwView => ({ kind: 'btw', session })
export const viewKey = (v: View) =>
  v.kind === 'task'
    ? `task:${v.session}:${v.id}`
    : v.kind === 'plan' || v.kind === 'review' || v.kind === 'btw'
      ? `${v.kind}:${v.session}`
      : v.kind === 'attachment'
        ? `attachment:${v.session}:${v.prompt}:${v.part}`
        : `${v.kind}:${v.id}`
/** The chat a view belongs to, if it only shows beside one. */
export const sessionOf = (v: View) => (v.kind === 'task' || v.kind === 'plan' || v.kind === 'review' || v.kind === 'attachment' || v.kind === 'btw' ? v.session : undefined)

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
  /** The chats last opened here, latest first. Only theirs keep their tasks, plans and attachments. */
  recent?: string[]
}

/** How many chats in a workspace keep their own panels while they're away. */
const RECENT_CHATS = 20

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
export function narrowTree(tree: Node, l: Layout): Node {
  const groups = groupsOf(tree)
  const main = groups.find((g) => g.id === l.focus) ?? groups[0]
  if (!main) return CHAT
  const merged: Group = { type: 'group', id: main.id, views: groups.flatMap((g) => g.views), active: activeOf(main) }
  const share = l.narrow ?? 0.45
  return { type: 'split', dir: 'col', children: [CHAT, merged], sizes: [1 - share, share] }
}

// ── One chat's view of its workspace's panels ──
//
// The layout is what was arranged, for every chat in the workspace; what a chat shows is worked out
// from it, never written back. So switching chats changes nothing stored: there's nothing to tidy
// up after the switch, and so nothing that shows for a moment and goes, and a chat's own tasks,
// plans and attachments are where they were when it's opened again.

/** For each split in a chat's tree that isn't the stored one: where the stored one is, and which of its children it kept. */
const sources = new WeakMap<Split, { path: number[]; index: number[] }>()

/**
 * The panels one chat sees: the workspace's, less other chats' tasks, plans and attachments, and
 * the groups and splits left empty without them. Splits aren't folded together, so each is one
 * stored split with some of its children, and resizing it can be put back there.
 */
export function shownTree(tree: Node, session: string): Node {
  const mine = (v: View) => (sessionOf(v) ?? session) === session
  if (viewsOf(tree).every(mine)) return tree
  const go = (n: Node, path: number[]): Node | undefined => {
    if (n.type === 'chat') return n
    if (n.type === 'group') {
      const views = n.views.filter(mine)
      return views.length === n.views.length ? n : views.length ? { ...n, views } : undefined
    }
    const kept = n.children.flatMap((c, i) => {
      const k = go(c, [...path, i])
      return k ? [{ node: k, index: i }] : []
    })
    if (kept.length < 2) return kept[0]?.node
    const total = kept.reduce((a, k) => a + n.sizes[k.index], 0)
    const split: Split = { ...n, children: kept.map((k) => k.node), sizes: kept.map((k) => n.sizes[k.index] / total) }
    sources.set(split, { path, index: kept.map((k) => k.index) })
    return split
  }
  return go(tree, []) ?? CHAT
}

/** Resizes a split as one chat sees it, `path` and `sizes` being in its shownTree. Panes it doesn't show keep their share. */
export function resizeShown(tree: Node, session: string, path: number[], sizes: number[]): Node {
  const shown = shownTree(tree, session)
  if (shown === tree) return setSizes(tree, path, sizes)
  let n = shown
  for (const i of path) if (n.type === 'split') n = n.children[i]
  const src = n.type === 'split' ? sources.get(n) : undefined
  let stored = tree
  for (const i of src?.path ?? []) if (stored.type === 'split') stored = stored.children[i]
  if (!src || stored.type !== 'split') return tree
  const room = src.index.reduce((a, i) => a + stored.sizes[i], 0)
  const next = [...stored.sizes]
  src.index.forEach((j, i) => (next[j] = sizes[i] * room))
  return setSizes(tree, src.path, next)
}

/** Moves a tab as one chat sees it: a tab-bar index counts only the tabs it shows. */
export function moveShown(tree: Node, session: string, key: string, drop: Drop): { tree: Node; group?: string } {
  if (drop.index === undefined) return moveView(tree, key, drop)
  const stored = groupsOf(tree).find((g) => g.id === drop.target)
  const shown = groupsOf(shownTree(tree, session)).find((g) => g.id === drop.target)
  const before = shown?.views[drop.index]
  const index = before ? stored!.views.findIndex((v) => viewKey(v) === viewKey(before)) : stored?.views.length
  return moveView(tree, key, { ...drop, index })
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

// Saved a moment after the last change rather than on every one, since dragging a divider changes it on every
// pointer move; and before the page goes, so nothing's lost.
let saveTimer: ReturnType<typeof setTimeout> | undefined
function save() {
  clearTimeout(saveTimer)
  saveTimer = undefined
  const json = JSON.stringify(layouts())
  sessionStorage.setItem(KEY, json)
  localStorage.setItem(KEY, json)
}
addEventListener('pagehide', () => saveTimer !== undefined && save())

export const layoutOf = (ws: Ws): Layout => layouts()[wsKey(ws)] ?? EMPTY

export function updateLayout(ws: Ws, change: (l: Layout) => Layout): void {
  const before = layoutOf(ws)
  const after = change(before)
  if (after === before) return
  const next = { ...layouts(), [wsKey(ws)]: after }
  setLayouts(next)
  clearTimeout(saveTimer)
  saveTimer = setTimeout(save, 300)
}

/** What a chat has on screen: its panels around it as the screen's width lays them out, or just itself with them hidden. */
export function screenTree(ws: Ws, session: string): Node {
  const l = layoutOf(ws)
  if (l.hidden) return CHAT
  const tree = shownTree(l.tree, session)
  return wide() ? tree : narrowTree(tree, l)
}

/** Whether a chat's panels are on screen. */
export const panelsShown = (ws: Ws, session: string) => groupsOf(screenTree(ws, session)).length > 0

/** Whether a view is on screen beside a chat: its group's tab showing, with panels shown. */
export const viewShown = (ws: Ws, session: string, key: string) => groupsOf(screenTree(ws, session)).some((g) => activeOf(g) === key)

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
 * Rejects if the terminal couldn't be started, for the caller to say so.
 */
export async function openTerminal(ws: Ws, session: string, cwd: string, where?: { group: string } | { beside: string; edge: Edge }, command?: string): Promise<void> {
  const { id } = await api.createTerminal({ cwd, machine: ws.machine, command })
  pending.add(id)
  const view: View = { kind: 'terminal', id }
  updateLayout(ws, (l) => {
    // The server's list may have got here first and placed it already.
    const tree = removeView(l.tree, viewKey(view))
    const groups = groupsOf(shownTree(tree, session))
    const into = where && 'group' in where ? where.group : !where ? (groups.find((g) => g.id === l.focus) ?? groups[0])?.id : undefined
    if (into && groups.some((g) => g.id === into)) return { ...l, tree: addToGroup(tree, into, view), focus: into, hidden: false }
    const placed = where && 'beside' in where ? splitWith(tree, where.beside, where.edge, [view]) : splitWith(tree, 'chat', 'bottom', [view])
    return { ...l, tree: placed.tree, focus: placed.group, hidden: false }
  })
  setFocusRequest(viewKey(view))
}

/**
 * Shows a view that needs nothing started, e.g. a task: where it already is,
 * else in the group last worked in, else in a new panel beside the chat.
 */
export function openView(ws: Ws, view: View): void {
  const key = viewKey(view)
  updateLayout(ws, (l) => {
    const at = groupOf(l.tree, key)
    if (at) return { ...l, tree: setActive(l.tree, key), focus: at.id, hidden: false }
    // Where its chat can see it: a group holding only other chats' views is hidden there.
    const groups = groupsOf(shownTree(l.tree, sessionOf(view) ?? ''))
    const into = groups.find((g) => g.id === l.focus) ?? groups[0]
    if (into) return { ...l, tree: addToGroup(l.tree, into.id, view), focus: into.id, hidden: false }
    const placed = splitWith(l.tree, 'chat', 'right', [view])
    return { ...l, tree: placed.tree, focus: placed.group, hidden: false }
  })
  setFocusRequest(key)
}

/**
 * Notes a chat being opened in a workspace. Other chats' tasks, plans and attachments stay, hidden,
 * for when they're opened again, unless they haven't been for a while. Nothing this chat shows changes.
 */
export function openedIn(ws: Ws, session: string): void {
  updateLayout(ws, (l) => {
    if (l.recent?.[0] === session) return l
    const recent = [session, ...(l.recent ?? []).filter((s) => s !== session)].slice(0, RECENT_CHATS)
    let tree = l.tree
    for (const v of viewsOf(tree)) if (sessionOf(v) && !recent.includes(sessionOf(v)!)) tree = removeView(tree, viewKey(v))
    return { ...l, tree, recent }
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

/**
 * Show or hide a chat's panels. Showing with nothing to show opens a shell, like any terminal panel; that rejects
 * if the shell couldn't be started.
 */
export async function togglePanels(ws: Ws, session: string, cwd: string): Promise<void> {
  if (panelsShown(ws, session)) return updateLayout(ws, (l) => ({ ...l, hidden: true }))
  const l = layoutOf(ws)
  const groups = groupsOf(shownTree(l.tree, session))
  if (!groups.length) return openTerminal(ws, session, cwd)
  updateLayout(ws, (l) => ({ ...l, hidden: false }))
  const g = groups.find((g) => g.id === l.focus) ?? groups[0]
  setFocusRequest(activeOf(g))
}
