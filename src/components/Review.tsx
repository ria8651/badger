import { For, Show, createContext, createEffect, createMemo, createResource, createSignal, on, onCleanup, onMount, untrack, useContext } from 'solid-js'
import { Check, ChevronDown, ChevronRight, MessageSquarePlus, RotateCw, Trash2 } from '../icons'
import type { ReviewAttention, ReviewDiff, ReviewFile, ReviewGroup, ReviewGuide, ReviewHunk, WireMessage } from '../../shared/protocol.ts'
import { api } from '../api.ts'
import { plural } from '../format.ts'
import { highlight, languageOf } from '../highlight.ts'
import { recall, remember, settle } from '../scrollMemory.ts'
import { TranscriptIndex } from '../transcript/context.ts'
import { itemsFor, type Block, type Index } from '../transcript/model.ts'
import type { Partial as Streaming } from '../useChat.ts'
import { Messages } from './Transcript.tsx'
import { Markdown } from './Markdown.tsx'
import { Button, DiffCount, GhostButton, LiveDot, inputClass } from './ui.tsx'

/*
 * SPIKE: a review chat's page. Its checkout's changes, every hunk, in the groups and order of the
 * guide Claude writes for them (report_review_guide), each group with what a reader needs to
 * follow it. You tick hunks off as you read, ask about lines (Claude answers beside them), and
 * send comments for Claude to act on, after which it updates the guide. What's kept (viewed
 * hunks, comments, questions) is in localStorage, per review chat.
 */

const GROUP_TOOL = 'review_guide_group'
const DONE_TOOL = 'review_guide_done'
/** How the whole guide was reported in one call, before groups came one at a time. */
const OLD_GUIDE_TOOL = 'report_review_guide'
/** Where a pinned column sits by its start: below its group's header, which is pinned at the top. */
const PINNED_TOP = 56

// ── What's kept, per review ──

/** Something said about some lines of a file. */
interface Note {
  id: string
  path: string
  /** Rows by anchor (n<line> on the new side, o<line> for a removed line); from = to for one line. */
  from: string
  to: string
  /** e.g. "line 12" or "lines 12–18". */
  where: string
  /** The rows it's on, as the diff showed them, so the message quotes what was seen. */
  code: string
  text: string
}

/** A question sent to Claude, found again in the transcript by its message to show the answer. */
interface Question extends Note {
  message: string
}

interface Saved {
  comments: Note[]
  /** A note on the whole thing, sent with the comments. */
  general: string
  /** Hunk ids. A hunk that changes gets a new id, so it's unread again. */
  viewed: string[]
  questions: Question[]
}

const EMPTY: Saved = { comments: [], general: '', viewed: [], questions: [] }
const stores = new Map<string, ReturnType<typeof createSignal<Saved>>>()
const storeKey = (session: string) => `badger.review2.${session}`

function useReview(session: string) {
  let s = stores.get(session)
  if (!s) {
    let initial = EMPTY
    try {
      initial = { ...EMPTY, ...JSON.parse(localStorage.getItem(storeKey(session)) ?? '{}') }
    } catch {}
    stores.set(session, (s = createSignal<Saved>(initial)))
  }
  const [saved, setSaved] = s
  const update = (f: (s: Saved) => Saved) => localStorage.setItem(storeKey(session), JSON.stringify(setSaved(f)))
  return { saved, update }
}

// ── The diff, as rows ──

type Line = { kind: 'ctx' | 'add' | 'del'; old?: number; new?: number; text: string; /** The characters that changed, from..to: against its pair, or all of it. */ marks?: [number, number][] }
type Row = { kind: 'hunk'; text: string } | Line

const anchorOf = (r: Line) => (r.kind === 'del' ? `o${r.old}` : `n${r.new}`)
const SIGN = { ctx: ' ', add: '+', del: '-' } as const

function rowsOf(patch: string): Row[] {
  const rows: Row[] = []
  let o = 0
  let n = 0
  for (const l of patch.split('\n')) {
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/.exec(l)
    if (h) {
      o = Number(h[1])
      n = Number(h[2])
      rows.push({ kind: 'hunk', text: h[3] })
    } else if (l.startsWith('+')) rows.push({ kind: 'add', new: n++, text: l.slice(1) })
    else if (l.startsWith('-')) rows.push({ kind: 'del', old: o++, text: l.slice(1) })
    else if (l.startsWith(' ')) rows.push({ kind: 'ctx', old: o++, new: n++, text: l.slice(1) })
  }
  markChanges(rows)
  return rows
}

/** Words, runs of spaces, and each other character: what a line's changes are found in. */
const TOKEN = /\w+|\s+|[^\w\s]/g
/** Past this many token pairs, comparing two lines isn't worth it: they're marked whole. */
const MAX_COMPARE = 250_000

/** All of a line but its indentation and trailing spaces, or nothing for a blank one. */
const whole = (text: string): [number, number][] => {
  const from = text.length - text.trimStart().length
  const to = text.trimEnd().length
  return from < to ? [[from, to]] : []
}

/**
 * What changed between a removed line and the added one it became, as ranges of each: the tokens that aren't in their
 * longest common subsequence, with ranges only spaces apart joined. Undefined when they have too little in common to be
 * one line edited, rather than one line swapped for another.
 */
function lineDiff(a: string, b: string): { a: [number, number][]; b: [number, number][] } | undefined {
  const x = a.match(TOKEN) ?? []
  const y = b.match(TOKEN) ?? []
  if (!x.length || !y.length || x.length * y.length > MAX_COMPARE) return
  // lcs[i][j]: the longest common subsequence of x from i and y from j.
  const lcs = Array.from({ length: x.length + 1 }, () => new Uint16Array(y.length + 1))
  for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) lcs[i][j] = x[i] === y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
  const keepX = new Array<boolean>(x.length).fill(false)
  const keepY = new Array<boolean>(y.length).fill(false)
  let same = 0
  for (let i = 0, j = 0; i < x.length && j < y.length; ) {
    if (x[i] === y[j]) {
      keepX[i] = keepY[j] = true
      if (x[i].trim()) same += x[i].length
      i++
      j++
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) i++
    else j++
  }
  const longest = Math.max(a.replace(/\s/g, '').length, b.replace(/\s/g, '').length)
  if (same < longest * 0.3) return
  const ranges = (tokens: string[], keep: boolean[]) => {
    const out: [number, number][] = []
    let at = 0
    tokens.forEach((t, i) => {
      const end = at + t.length
      if (!keep[i]) {
        const last = out.at(-1)
        // Joined across spaces kept between them: "foo bar" to "baz qux" is one change, not two.
        if (last && tokens.slice(0, i).join('').slice(last[1]).trim() === '') last[1] = end
        else out.push([at, end])
      }
      at = end
    })
    return out.filter(([f, t]) => t > f)
  }
  return { a: ranges(x, keepX), b: ranges(y, keepY) }
}

/**
 * Every changed character, so the strong colour always means changed and the row's tint alone means part of a change.
 * In a run of removed lines then added ones, each pair in order is compared, if they're alike enough to be a line edited;
 * any other line, removed or added, changed whole.
 */
function markChanges(rows: Row[]) {
  for (let i = 0; i < rows.length; ) {
    let d = i
    while (d < rows.length && rows[d].kind === 'del') d++
    let a = d
    while (a < rows.length && rows[a].kind === 'add') a++
    const removed = rows.slice(i, d) as Line[]
    const added = rows.slice(d, a) as Line[]
    removed.forEach((x, k) => {
      const y = added[k]
      const diff = y && lineDiff(x.text, y.text)
      x.marks = diff ? diff.a : whole(x.text)
      if (y) y.marks = diff ? diff.b : whole(y.text)
    })
    for (const y of added.slice(removed.length)) y.marks = whole(y.text)
    i = Math.max(a, i + 1)
  }
}

// ── Marks drawn as one shape ──

type Box = { l: number; r: number; t: number; b: number }

/** Where characters from..to of an element's text are on screen: a box per piece, per line it wraps onto. */
function textBoxes(el: HTMLElement, [from, to]: [number, number]): DOMRect[] {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  const range = document.createRange()
  let at = 0
  let started = false
  while (walker.nextNode()) {
    const t = walker.currentNode as Text
    if (!started && from <= at + t.length) {
      range.setStart(t, from - at)
      started = true
    }
    if (started && to <= at + t.length) {
      range.setEnd(t, to - at)
      return [...range.getClientRects()]
    }
    at += t.length
  }
  return []
}

/**
 * Boxes as rounded shapes, the way an editor draws a selection: boxes on the same line that touch become one, a box that
 * overlaps one on the line straight above joins it, and each shape is traced around its outline with every corner rounded,
 * outward where it sticks out and inward where it steps in, as one SVG path.
 */
function blobs(boxes: Box[], radius: number): string {
  boxes.sort((p, q) => p.t - q.t || p.l - q.l)
  const lines: Box[] = []
  for (const b of boxes) {
    const last = lines.at(-1)
    if (last && Math.abs(last.t - b.t) < 1 && b.l <= last.r + 1) last.r = Math.max(last.r, b.r)
    else lines.push({ ...b })
  }
  // A chain of boxes, one per line, each overlapping the one above; a box that would join two starts a chain of its own.
  const chains: Box[][] = []
  for (const b of lines) {
    const chain = chains.find((c) => {
      const above = c.at(-1)!
      return Math.abs(above.b - b.t) < 1 && b.l < above.r && b.r > above.l
    })
    if (chain) chain.push(b)
    else chains.push([b])
  }
  return chains
    .map((c) => {
      // Edges only a little apart on lines next to each other line up, as the wider: a step too short to round would wiggle.
      for (let pass = 0; pass < 2; pass++) {
        for (let i = 0; i + 1 < c.length; i++) {
          if (Math.abs(c[i].r - c[i + 1].r) < radius * 2) c[i].r = c[i + 1].r = Math.max(c[i].r, c[i + 1].r)
          if (Math.abs(c[i].l - c[i + 1].l) < radius * 2) c[i].l = c[i + 1].l = Math.min(c[i].l, c[i + 1].l)
        }
      }
      // Down the right side, then back up the left.
      const pts: [number, number][] = [[c[0].l, c[0].t]]
      c.forEach((b) => pts.push([b.r, b.t], [b.r, b.b]))
      for (let i = c.length - 1; i >= 0; i--) pts.push([c[i].l, c[i].b], [c[i].l, c[i].t])
      return roundedPath(outline(pts), radius)
    })
    .join(' ')
}

/** A polygon without repeated points or points in the middle of a straight edge. */
function outline(pts: [number, number][]): [number, number][] {
  const same = (p: [number, number], q: [number, number]) => Math.abs(p[0] - q[0]) < 0.5 && Math.abs(p[1] - q[1]) < 0.5
  let out = pts.filter((p, i) => !same(p, pts[(i + 1) % pts.length]))
  const straight = (p: [number, number], v: [number, number], q: [number, number]) =>
    (Math.abs(p[0] - v[0]) < 0.5 && Math.abs(v[0] - q[0]) < 0.5) || (Math.abs(p[1] - v[1]) < 0.5 && Math.abs(v[1] - q[1]) < 0.5)
  for (let changed = true; changed && out.length > 3; ) {
    changed = false
    out = out.filter((v, i) => {
      const keep = !straight(out[(i - 1 + out.length) % out.length], v, out[(i + 1) % out.length])
      if (!keep) changed = true
      return keep
    })
  }
  return out
}

/** A polygon traced with each corner rounded: cut back along both edges by up to `radius`, and joined by a curve through it. */
function roundedPath(pts: [number, number][], radius: number): string {
  const n = pts.length
  if (n < 3) return ''
  let d = ''
  for (let i = 0; i < n; i++) {
    const p = pts[(i - 1 + n) % n]
    const v = pts[i]
    const q = pts[(i + 1) % n]
    const d1 = Math.hypot(p[0] - v[0], p[1] - v[1])
    const d2 = Math.hypot(q[0] - v[0], q[1] - v[1])
    const r = Math.min(radius, d1 / 2, d2 / 2)
    const a = [v[0] + ((p[0] - v[0]) / d1) * r, v[1] + ((p[1] - v[1]) / d1) * r]
    const b = [v[0] + ((q[0] - v[0]) / d2) * r, v[1] + ((q[1] - v[1]) / d2) * r]
    d += `${i ? 'L' : 'M'}${a[0].toFixed(1)},${a[1].toFixed(1)}Q${v[0].toFixed(1)},${v[1].toFixed(1)} ${b[0].toFixed(1)},${b[1].toFixed(1)}`
  }
  return d + 'Z'
}

// ── What Claude said: the guide, and answers ──

/** The chat's guide calls, by tool name's end: tools are named mcp__<server>__<tool>. */
const guideCall = (name?: string) => [GROUP_TOOL, DONE_TOOL, OLD_GUIDE_TOOL].find((t) => name?.endsWith(`__${t}`))

/** The guide calls and how each went, as a string: the guide only needs working out again when this changes. */
function guideCalls(index: Index): string {
  let key = ''
  for (const m of index.groups.get('') ?? []) {
    if (m.type !== 'assistant') continue
    for (const b of ((m.message as { content?: Block[] })?.content ?? []) as Block[]) {
      if (b.type !== 'tool_use' || !b.id || !guideCall(b.name)) continue
      const r = index.results.get(b.id)
      key += `${b.id}:${r ? (r.isError ? 'x' : 'ok') : '…'} `
    }
  }
  return key
}

/**
 * The guide as the chat's guide calls left it, those that were shown, in order. A group call adds a group or changes one,
 * keeping what it leaves out, and takes its hunks from any other group; a done call sets the summary and the order, and
 * says it's whole. (A chat from before groups came one at a time reported the whole guide in one call.) `writing`: a call
 * is out, or groups have come since the last done.
 */
function guideOf(index: Index): { guide?: ReviewGuide; writing: boolean } {
  let order: string[] = []
  const groups = new Map<string, ReviewGroup>()
  let summary = ''
  let done = false
  let pending = false
  for (const m of index.groups.get('') ?? []) {
    if (m.type !== 'assistant') continue
    for (const b of ((m.message as { content?: Block[] })?.content ?? []) as Block[]) {
      const call = b.type === 'tool_use' && b.id ? guideCall(b.name) : undefined
      if (!call) continue
      const result = index.results.get(b.id!)
      if (!result) {
        pending = true
        continue
      }
      if (result.isError) continue
      const input = (b.input ?? {}) as Partial<ReviewGroup> & { summary?: string; groups?: Partial<ReviewGroup>[]; order?: string[]; remove?: string[] }
      if (call === GROUP_TOOL && input.id) {
        const old = groups.get(input.id)
        if (!old) order.push(input.id)
        if (input.hunks) {
          const moving = new Set(input.hunks)
          for (const g of groups.values()) if (g.id !== input.id) g.hunks = g.hunks.filter((h) => !moving.has(h))
        }
        groups.set(input.id, {
          id: input.id,
          title: input.title ?? old?.title ?? input.id,
          attention: input.attention ?? old?.attention ?? 'medium',
          kind: input.kind ?? old?.kind,
          explanation: input.explanation ?? old?.explanation ?? '',
          hunks: input.hunks ?? old?.hunks ?? [],
        })
        done = false
      } else if (call === DONE_TOOL) {
        for (const id of input.remove ?? []) groups.delete(id)
        order = [...new Set([...(input.order ?? []), ...order])].filter((id) => groups.has(id))
        summary = input.summary ?? summary
        done = true
      } else if (call === OLD_GUIDE_TOOL) {
        const before = new Map(groups)
        groups.clear()
        for (const g of input.groups ?? []) {
          const old = before.get(g.id ?? '')
          groups.set(g.id ?? '', {
            id: g.id ?? '',
            title: g.title ?? old?.title ?? g.id ?? '',
            attention: g.attention ?? old?.attention ?? 'medium',
            kind: g.kind ?? old?.kind,
            explanation: g.explanation ?? old?.explanation ?? '',
            hunks: g.hunks ?? [],
          })
        }
        order = [...groups.keys()]
        summary = input.summary ?? summary
        done = true
      }
    }
  }
  const guide = groups.size ? { summary, groups: order.flatMap((id) => (groups.has(id) ? [groups.get(id)!] : [])) } : undefined
  return { guide, writing: pending || (!!guide && !done) }
}

/**
 * Claude's answer to each question, by its id: the conversation from the question until the next message the user sent,
 * without how the turn ended. `latest`: nothing's been sent since, so what's streaming now is the rest of it.
 */
type Answer = { messages: WireMessage[]; latest: boolean }
function answersOf(index: Index, questions: Question[]): Map<string, Answer> {
  const ids = new Map(questions.map((q) => [q.message.trim(), q.id]))
  const out = new Map<string, Answer>()
  let current: Answer | undefined
  for (const m of index.groups.get('') ?? []) {
    const prompt = itemsFor(m).find((i) => i.kind === 'user')
    if (prompt?.kind === 'user') {
      if (current) current.latest = false
      const id = ids.get(prompt.text.trim())
      current = id ? { messages: [], latest: true } : undefined
      if (id && current) out.set(id, current)
    } else if (current && m.type !== 'result') current.messages.push(m)
  }
  return out
}

// ── The outline ──

/** A row of a group's outline: a folder, or a file with the group's hunks in it. */
type OutlineRow = { kind: 'folder'; name: string; path: string; depth: number } | { kind: 'file'; name: string; path: string; depth: number; hunks: Placed[] }

type Folder = { folders: Map<string, Folder>; files: Map<string, Placed[]> }

/**
 * A group's hunks as a tree of folders and files, flattened into rows. A folder with only one folder in it shares its row,
 * as a/b/, and everything keeps the order it first comes in the group, which is the order it's read in. A file is current, and
 * ticked, by all its hunks in the group.
 */
const outlines = new WeakMap<Placed[], OutlineRow[]>()
function outlineRows(hunks: Placed[]): OutlineRow[] {
  const cached = outlines.get(hunks)
  if (cached) return cached
  const root: Folder = { folders: new Map(), files: new Map() }
  for (const p of hunks) {
    const parts = p.file.path.split('/')
    const name = parts.pop()!
    let at = root
    for (const part of parts) {
      if (!at.folders.has(part)) at.folders.set(part, { folders: new Map(), files: new Map() })
      at = at.folders.get(part)!
    }
    at.files.set(name, [...(at.files.get(name) ?? []), p])
  }
  const rows: OutlineRow[] = []
  const walk = (folder: Folder, prefix: string, depth: number) => {
    for (let [name, sub] of folder.folders) {
      let path = prefix + name
      while (sub.folders.size === 1 && !sub.files.size) {
        const [next, inner] = [...sub.folders][0]
        name += `/${next}`
        path += `/${next}`
        sub = inner
      }
      rows.push({ kind: 'folder', name, path, depth })
      walk(sub, `${path}/`, depth + 1)
    }
    for (const [name, list] of folder.files) rows.push({ kind: 'file', name, path: prefix + name, depth, hunks: list })
  }
  walk(root, '', 0)
  outlines.set(hunks, rows)
  return rows
}

// ── Messages to Claude ──

const quote = (n: Note) => `${n.path}, ${n.where}:\n\`\`\`diff\n${n.code}\n\`\`\``

function commentsMessage(comments: Note[], general: string): string {
  return [
    `I left ${plural(comments.length, 'comment')} on the changes. Make the changes they ask for, and say if you disagree with any. Then update the guide for what changed (${GROUP_TOOL}, then ${DONE_TOOL}).`,
    general.trim(),
    ...comments.map((c) => `${quote(c)}\n${c.text.trim()}`),
  ]
    .filter(Boolean)
    .join('\n\n')
}

const questionMessage = (n: Note) => `A question about ${quote(n)}\n${n.text.trim()}\n\n(Just answer; don't change anything for this.)`

const UPDATE_GUIDE = `The changes have moved on since your last guide. Call review_diff for what's new, put it in groups with ${GROUP_TOOL} (new ones, or ones that changed), then call ${DONE_TOOL}.`

// ── The page ──

/** A part of the page: one of the guide's groups, hunks changed since it, or before there's a guide, a file. */
interface Section {
  id: string
  title: string
  attention?: ReviewAttention | 'changed'
  kind?: string
  explanation?: string
  hunks: Placed[]
}
type Placed = { file: ReviewFile; hunk: ReviewHunk }

/** What an answer streaming in needs from its chat, for the transcript's own rendering of it. */
interface LiveChat {
  partial: () => Streaming | null
  bashOutput: () => Record<string, string>
  children: () => Record<string, string> | undefined
  running: () => boolean
  cwd: () => string | undefined
}
const LiveChatContext = createContext<LiveChat>()

/** Where a new comment or question is going: rows from..to of one hunk. */
interface Draft {
  hunk: string
  from: number
  to: number
  /** Editing this comment, rather than adding one. */
  id?: string
  /** Still being dragged over, so the box to write in waits for the drag to end. */
  picking?: boolean
}

export function ReviewPage(props: {
  sessionId: string
  /** Where git runs. */
  cwd?: string
  machine: string
  index: () => Index
  /** Read again when a turn ends, since that's when files change. */
  running: boolean
  /** Sends a message to the chat; absent when it can't take one. */
  onSend?: (text: string) => void
  /** What's streaming in, for answers to show as the conversation does. */
  partial: Streaming | null
  bashOutput: Record<string, string>
  children?: Record<string, string>
}) {
  const { saved, update } = useReview(untrack(() => props.sessionId))
  const [diff, setDiff] = createSignal<ReviewDiff>()
  const [error, setError] = createSignal<string>()
  const [loading, setLoading] = createSignal(false)
  /** Hunks opened or folded by hand, overriding whether they're viewed. */
  const [open, setOpen] = createSignal<Record<string, boolean>>({})
  const [draft, setDraft] = createSignal<Draft>()
  const [draftText, setDraftText] = createSignal('')

  let seq = 0
  const load = async () => {
    const dir = props.cwd
    if (!dir) return
    const mine = ++seq
    setLoading(true)
    try {
      const next = await api.review(dir, 'base', 3, props.machine)
      if (mine !== seq) return
      setDiff(next)
      setError(undefined)
    } catch (e) {
      if (mine === seq) setError((e as Error).message)
    } finally {
      if (mine === seq) setLoading(false)
    }
  }
  createEffect(on(() => props.cwd, () => void load()))
  createEffect(on(() => props.running, (r) => !r && void load(), { defer: true }))

  // Worked out again only when a guide call comes or finishes, not on every message.
  const told = createMemo(on(createMemo(() => guideCalls(props.index())), () => guideOf(untrack(props.index))))
  const guide = () => told().guide
  const answers = createMemo(() => answersOf(props.index(), saved().questions))

  // Kept the same where a hunk is, so reading the diff again (each time a turn ends) doesn't redraw what hasn't changed.
  const placed = createMemo<Map<string, Placed>>((before) => {
    const all = new Map<string, Placed>()
    for (const file of diff()?.files ?? []) {
      for (const hunk of file.hunks) {
        const was = before?.get(hunk.id)
        const same = was && was.hunk.patch === hunk.patch && was.file.path === file.path && was.file.status === file.status && was.file.oldPath === file.oldPath
        all.set(hunk.id, same ? was : { file, hunk })
      }
    }
    return all
  })
  /** Sections by what they hold, so one that hasn't changed stays the same object and isn't drawn again. */
  let sectionCache = new Map<string, Section>()
  const keep = (s: Section): Section => {
    const key = [s.id, s.title, s.attention, s.kind, s.explanation, ...s.hunks.map((p) => p.hunk.id)].join('\0')
    const was = sectionCache.get(key)
    const same = was && was.hunks.every((p, i) => p === s.hunks[i])
    return same ? was : s
  }
  const sections = createMemo((): Section[] => {
    const all = placed()
    const g = guide()
    let out: Section[]
    if (!g) {
      out = (diff()?.files ?? []).map((f) => ({ id: `file:${f.path}`, title: f.path, hunks: f.hunks.map((hunk) => all.get(hunk.id)!) }))
    } else {
      const inGuide = new Set(g.groups.flatMap((x) => x.hunks))
      const rest = [...all.values()].filter((p) => !inGuide.has(p.hunk.id))
      const groups = g.groups
        .map((x) => ({ ...x, hunks: x.hunks.flatMap((id) => (all.has(id) ? [all.get(id)!] : [])) }))
        .filter((x) => x.hunks.length)
      // While Claude is still writing the guide, what it hasn't got to yet goes last; once it's done, anything outside it is new.
      out = !rest.length
        ? groups
        : told().writing
          ? [...groups, { id: 'rest', title: 'Not in the guide yet', hunks: rest }]
          : [{ id: 'changed', title: 'Changed since the guide', attention: 'changed' as const, hunks: rest }, ...groups]
    }
    out = out.map(keep)
    sectionCache = new Map(out.map((x) => [[x.id, x.title, x.attention, x.kind, x.explanation, ...x.hunks.map((p) => p.hunk.id)].join('\0'), x]))
    return out
  })

  const viewed = createMemo(() => new Set(saved().viewed))
  const isViewed = (id: string) => viewed().has(id)
  const total = () => placed().size
  const viewedCount = () => [...placed().keys()].filter(isViewed).length
  const isOpen = (id: string) => open()[id] ?? !isViewed(id)
  const setViewed = (ids: string[], on: boolean) => {
    update((s) => ({ ...s, viewed: on ? [...new Set([...s.viewed, ...ids])] : s.viewed.filter((v) => !ids.includes(v)) }))
    setOpen((o) => ({ ...o, ...Object.fromEntries(ids.map((id) => [id, !on])) }))
  }

  // ── Comments and questions ──

  const startDraft = (hunk: string, at: number, extend: boolean) => {
    const d = draft()
    if (extend && d && d.hunk === hunk && !d.id) return setDraft({ hunk, from: Math.min(d.from, at), to: Math.max(d.to, at) })
    setDraft({ hunk, from: at, to: at })
    setDraftText('')
  }
  /** Lines `anchor` to `at` of a hunk, either way round, as a new comment's while dragging over them. */
  const spanDraft = (hunk: string, anchor: number, at: number, picking: boolean) => {
    if (draft()?.hunk !== hunk || draft()?.id) setDraftText('')
    setDraft({ hunk, from: Math.min(anchor, at), to: Math.max(anchor, at), picking })
  }
  /** The draft as a note on its lines, or undefined if it's empty. */
  const noteOf = (rows: Row[], path: string): Note | undefined => {
    const d = draft()
    const text = draftText().trim()
    if (!d || !text) return
    const span = rows.slice(d.from, d.to + 1).filter((r): r is Line => r.kind !== 'hunk')
    if (!span.length) return
    const first = span[0]
    const last = span[span.length - 1]
    const num = (r: Line) => r.new ?? r.old
    const where = span.length === 1 ? `line ${num(first)}${first.kind === 'del' ? ' (removed)' : ''}` : `lines ${num(first)}–${num(last)}`
    return { id: d.id ?? crypto.randomUUID(), path, from: anchorOf(first), to: anchorOf(last), where, code: span.map((r) => SIGN[r.kind] + r.text).join('\n'), text }
  }
  const closeDraft = () => {
    setDraft(undefined)
    setDraftText('')
  }
  const saveComment = (rows: Row[], path: string) => {
    const note = noteOf(rows, path)
    const editing = draft()?.id
    if (note) update((s) => ({ ...s, comments: editing ? s.comments.map((c) => (c.id === editing ? { ...c, text: note.text } : c)) : [...s.comments, note] }))
    closeDraft()
  }
  const ask = (rows: Row[], path: string) => {
    const note = noteOf(rows, path)
    if (!note || !props.onSend) return
    const message = questionMessage(note)
    props.onSend(message)
    update((s) => ({ ...s, questions: [...s.questions, { ...note, message }] }))
    closeDraft()
  }
  const removeComment = (id: string) => update((s) => ({ ...s, comments: s.comments.filter((c) => c.id !== id) }))
  const removeQuestion = (id: string) => update((s) => ({ ...s, questions: s.questions.filter((q) => q.id !== id) }))

  const send = () => {
    const s = saved()
    if (!props.onSend || (!s.comments.length && !s.general.trim())) return
    props.onSend(commentsMessage(s.comments, s.general))
    update((x) => ({ ...x, comments: [], general: '' }))
  }

  /** Comments whose lines aren't in any hunk now, e.g. after Claude changed them. */
  const loose = createMemo(() => {
    const shown = new Set<string>()
    for (const p of placed().values()) for (const r of rowsOf(p.hunk.patch)) if (r.kind !== 'hunk') shown.add(`${p.file.path}:${anchorOf(r)}`)
    return saved().comments.filter((c) => !shown.has(`${c.path}:${c.to}`))
  })

  const sectionEls = new Map<string, HTMLElement>()
  const hunkEls = new Map<string, HTMLElement>()
  const jumpTo = (el?: HTMLElement) => el?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  /** The section being read, the last whose top has scrolled up past the pinned header, and its hunk at the top of the view. */
  const [current, setCurrent] = createSignal<string>()
  const [currentHunk, setCurrentHunk] = createSignal<string>()
  let scroller!: HTMLDivElement
  const track = () => {
    const top = scroller.getBoundingClientRect().top + PINNED_TOP + 8
    let at: string | undefined
    let hunk: string | undefined
    let last: Section | undefined
    for (const s of sections()) {
      const el = sectionEls.get(s.id)
      if (!el || el.getBoundingClientRect().top > top) break
      last = s
    }
    at = last?.id
    hunk = last?.hunks.find((p) => (hunkEls.get(p.hunk.id)?.getBoundingClientRect().bottom ?? 0) > top)?.hunk.id
    setCurrent(at ?? sections()[0]?.id)
    setCurrentHunk(hunk)
    // Where it's been read to, as the hunk at the top and how far down it, since off-screen hunks only have a guessed height.
    if (!restoring) {
      const el = hunk && hunkEls.get(hunk)
      remember(scrollKey, el && scroller.scrollTop > 0 ? { hunk, offset: top - el.getBoundingClientRect().top } : undefined)
    }
  }
  const scrollKey = `review:${untrack(() => props.sessionId)}`
  let content!: HTMLDivElement
  const spot = recall<{ hunk: string; offset: number }>(scrollKey)
  // Not saved over until it's been gone back to: the page starts at the top while the diff loads.
  let restoring = !!spot
  let restored = false
  /** No going back once the page is being used, or the hunk has gone: it would jump from under the reader. */
  const giveUp = () => {
    restored = true
    restoring = false
  }
  onMount(() => {
    for (const e of ['wheel', 'touchstart', 'keydown', 'pointerdown']) scroller.addEventListener(e, () => restored || giveUp(), { once: true, passive: true })
  })
  // Back to where it was read to, as soon as that hunk is on the page.
  const tryRestore = () => {
    if (restored || !spot) return
    if (diff() && !placed().has(spot.hunk)) return giveUp()
    if (!hunkEls.has(spot.hunk)) return
    restored = true
    requestAnimationFrame(() => {
      const stop = settle(scroller, content, () => {
        const el = hunkEls.get(spot.hunk)
        if (el) scroller.scrollTop += el.getBoundingClientRect().top - (scroller.getBoundingClientRect().top + PINNED_TOP + 8) + spot.offset
      })
      // Saving again once it's settled, or the user takes over.
      setTimeout(() => {
        stop()
        restoring = false
      }, 3000)
      for (const e of ['wheel', 'touchstart', 'keydown', 'pointerdown']) scroller.addEventListener(e, () => (restoring = false), { once: true, passive: true })
    })
  }
  createEffect(on(sections, tryRestore))
  /** Groups opened or folded in the outline by hand; otherwise only the one being read is open. */
  const [unfolded, setUnfolded] = createSignal<Record<string, boolean>>({})
  const isUnfolded = (id: string) => unfolded()[id] ?? current() === id
  createEffect(on(sections, () => requestAnimationFrame(track)))

  /**
   * A group's explanation and its hunks, side by side, each pinned so neither leaves empty space: one that fits sits below
   * the group's header; one taller than the space scrolls with the page, both ways, until its end (or its start, going back
   * up) comes into view, and stays there. So each moves only while there's more of it to see, and nothing scrolls on its own.
   * Done by moving each one's sticky top with the scroll, kept between pinned by its start and pinned by its end.
   */
  // Sizes come from one ResizeObserver rather than being measured on each scroll, so placing them only writes.
  const pinned = new Map<HTMLElement, { top: number; height: number }>()
  let viewHeight = 0
  let scrolled = 0
  const place = (el: HTMLElement, top: number) => {
    const p = pinned.get(el)
    if (!p) return
    const byEnd = Math.min(PINNED_TOP, viewHeight - p.height - 12)
    const at = Math.max(byEnd, Math.min(PINNED_TOP, top))
    if (at === p.top && el.style.top) return
    p.top = at
    el.style.top = `${at}px`
  }
  const sizes = new ResizeObserver((entries) => {
    for (const e of entries) {
      const height = e.borderBoxSize[0]?.blockSize ?? e.contentRect.height
      if (e.target === scroller) viewHeight = height
      else {
        const p = pinned.get(e.target as HTMLElement)
        if (p) p.height = height
      }
    }
    for (const [el, p] of pinned) place(el, p.top)
  })
  onMount(() => sizes.observe(scroller))
  onCleanup(() => sizes.disconnect())
  // Once a frame however fast the scroll events come: what's being read is measured first, then the columns move.
  let frame = 0
  const onScroll = () => {
    if (frame) return
    frame = requestAnimationFrame(() => {
      frame = 0
      const moved = scroller.scrollTop - scrolled
      scrolled = scroller.scrollTop
      track()
      for (const [el, p] of pinned) place(el, p.top - moved)
    })
  }
  const pin = (el: HTMLElement) => {
    pinned.set(el, { top: PINNED_TOP, height: 0 })
    sizes.observe(el)
    onCleanup(() => {
      sizes.unobserve(el)
      pinned.delete(el)
    })
  }

  const live: LiveChat = {
    partial: () => props.partial,
    bashOutput: () => props.bashOutput,
    children: () => props.children,
    running: () => props.running,
    cwd: () => props.cwd,
  }

  return (
    <TranscriptIndex.Provider value={props.index}>
    <LiveChatContext.Provider value={live}>
    <div class="@container flex min-h-0 flex-1 flex-col text-ui">
      <div class="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-3 py-1.5 text-xs text-fg-3">
        <Show when={diff()}>
          {(d) => (
            <>
              <span>
                <span class="font-mono text-fg-2">{d().branch || 'detached'}</span>
                <Show when={d().base}> against <span class="font-mono text-fg-2">{d().base}</span></Show>
              </span>
              <DiffCount
                files={d().files.length}
                added={d().files.reduce((n, f) => n + f.added, 0)}
                removed={d().files.reduce((n, f) => n + f.removed, 0)}
              />
            </>
          )}
        </Show>
        <div class="flex-1" />
        <Show when={total()}>
          <div class="flex items-center gap-2">
            <div class="h-1.5 w-24 overflow-hidden rounded-full bg-surface">
              <div class="h-full rounded-full bg-ok transition-[width]" style={{ width: `${(viewedCount() / total()) * 100}%` }} />
            </div>
            <span class="tabular-nums">
              {viewedCount()}/{plural(total(), 'hunk')} viewed
            </span>
          </div>
        </Show>
        <GhostButton title="Read the changes again" onClick={() => void load()}>
          <RotateCw class={`size-3.5 ${loading() ? 'animate-spin' : ''}`} />
        </GhostButton>
      </div>

      <div class="flex min-h-0 flex-1">
        <nav class="hidden w-72 shrink-0 overflow-y-auto border-r border-line py-2 @6xl:block">
          <For each={sections()}>
            {(s) => {
              const done = () => s.hunks.filter((p) => isViewed(p.hunk.id)).length
              return (
                <div>
                  <div class={`flex items-center ${current() === s.id ? 'bg-surface' : 'hover:bg-surface/60'}`}>
                    <button
                      onClick={() => setUnfolded((u) => ({ ...u, [s.id]: !isUnfolded(s.id) }))}
                      title={isUnfolded(s.id) ? 'Fold' : 'Show its hunks'}
                      class="grid h-6 w-6 shrink-0 place-items-center pl-1 text-fg-3 hover:text-fg-2"
                    >
                      {isUnfolded(s.id) ? <ChevronDown class="size-3" /> : <ChevronRight class="size-3" />}
                    </button>
                    <button onClick={() => jumpTo(sectionEls.get(s.id))} title={s.title} class="flex min-w-0 flex-1 items-center gap-2 py-1 pr-3 text-left text-xs">
                      <AttentionDot attention={s.attention} />
                      <span class={`min-w-0 flex-1 truncate ${current() === s.id ? 'text-fg' : done() === s.hunks.length ? 'text-fg-3' : 'text-fg-2'}`}>{s.title}</span>
                      <Show when={done() === s.hunks.length} fallback={<span class="shrink-0 text-fg-3 tabular-nums">{done()}/{s.hunks.length}</span>}>
                        <Check class="size-3 shrink-0 text-ok" />
                      </Show>
                    </button>
                  </div>
                  <Show when={isUnfolded(s.id)}>
                    <For each={outlineRows(s.hunks)}>
                      {(row) => {
                        const ids = row.kind === 'folder' ? [] : row.hunks.map((p) => p.hunk.id)
                        const here = () => ids.includes(currentHunk() ?? '')
                        const done = () => ids.length > 0 && ids.every(isViewed)
                        const indent = { 'padding-left': `${1.75 + row.depth * 0.75}rem` }
                        if (row.kind === 'folder')
                          return (
                            <div style={indent} title={row.path} class="truncate py-0.5 pr-3 font-mono text-xs text-fg-3">
                              {row.name}/
                            </div>
                          )
                        return (
                          <button
                            ref={(el) => createEffect(() => here() && el.scrollIntoView({ block: 'nearest' }))}
                            onClick={() => jumpTo(hunkEls.get(row.hunks[0].hunk.id))}
                            title={row.path}
                            style={indent}
                            class={`flex w-full items-center gap-2 py-0.5 pr-3 text-left font-mono text-xs ${here() ? 'bg-surface text-fg' : done() ? 'text-fg-3 hover:bg-surface/60' : 'text-fg-2 hover:bg-surface/60'}`}
                          >
                            <span class={`h-3.5 w-0.5 shrink-0 rounded-full ${here() ? 'bg-primary' : 'bg-line'}`} />
                            <span class="min-w-0 flex-1 truncate">{row.name}</span>
                            <Show when={done()}>
                              <Check class="size-3 shrink-0 text-ok" />
                            </Show>
                          </button>
                        )
                      }}
                    </For>
                  </Show>
                </div>
              )
            }}
          </For>
        </nav>

        <div ref={scroller} onScroll={onScroll} class="min-w-0 flex-1 overflow-y-auto">
          <div ref={content} class="mx-auto max-w-[100rem] px-4 pb-10 @3xl:px-6">
            <Show when={!diff() && loading()}>
              <p class="p-10 text-center text-fg-3">Reading the changes…</p>
            </Show>
            <Show when={error()}>
              <p class="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">{error()}</p>
            </Show>
            <Show
              when={guide()}
              fallback={
                <Show when={diff()}>
                  <p class="mt-4 flex items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2 text-fg-2">
                    <Show when={props.running || told().writing}>
                      <LiveDot />
                    </Show>
                    {props.running || told().writing
                      ? 'Claude is reading the changes to write a guide. Meanwhile, here they are file by file.'
                      : 'No guide yet. Here are the changes file by file.'}
                  </p>
                </Show>
              }
            >
              {(g) => (
                <Show when={g().summary}>
                  <div class="mt-4 rounded-lg border border-line bg-surface px-4 py-3">
                    <Markdown text={g().summary} />
                  </div>
                </Show>
              )}
            </Show>
            <Show when={loose().length}>
              <div class="mt-4 rounded-lg border border-line px-3 py-2">
                <p class="mb-1 text-xs text-fg-3">Comments on lines that aren’t in the diff any more</p>
                <For each={loose()}>{(c) => <CommentBox note={c} onRemove={() => removeComment(c.id)} />}</For>
              </div>
            </Show>
            <Show when={diff() && !total() && !loading()}>
              <p class="p-10 text-center text-fg-3">Nothing to review: no changes that aren’t on the base already.</p>
            </Show>

            <For each={sections()}>
              {(s) => {
                const side = () => !!s.explanation || s.attention === 'changed'
                return (
                  <section ref={(el) => sectionEls.set(s.id, el)} class="mt-5 scroll-mt-3 rounded-xl border border-line">
                    {/* Stuck to the top while its group is in view, so you know which one you're in. */}
                    <header class="sticky top-0 z-10 flex flex-wrap items-center gap-2 rounded-t-xl border-b border-line bg-bg px-3 py-2">
                      <AttentionBadge attention={s.attention} />
                      <h2 class={`min-w-0 ${s.id.startsWith('file:') ? 'font-mono text-xs' : 'text-base'} text-fg`}>{s.title}</h2>
                      <Show when={s.kind}>
                        <span class="text-xs text-fg-3">{s.kind}</span>
                      </Show>
                      <div class="flex-1" />
                      <span class="text-xs text-fg-3 tabular-nums">
                        {s.hunks.filter((p) => isViewed(p.hunk.id)).length}/{plural(s.hunks.length, 'hunk')}
                      </span>
                      <Show when={s.attention === 'changed' && props.onSend}>
                        <Button class="flex h-7 items-center gap-1 text-xs" disabled={props.running} onClick={() => props.onSend!(UPDATE_GUIDE)}>
                          Update the guide
                        </Button>
                      </Show>
                      <button
                        onClick={() => {
                          const ids = s.hunks.map((p) => p.hunk.id)
                          setViewed(ids, !ids.every(isViewed))
                        }}
                        class="rounded px-1.5 py-0.5 text-xs text-fg-3 hover:bg-surface hover:text-fg-2"
                      >
                        {s.hunks.every((p) => isViewed(p.hunk.id)) ? 'Mark unviewed' : s.hunks.length > 1 ? 'Mark all viewed' : 'Mark viewed'}
                      </button>
                    </header>
                    {/* The explanation beside its hunks where there's room, each pinned (see pin); above them where there isn't. */}
                    <div class={`grid gap-4 p-3 ${side() ? '@4xl:grid-cols-[minmax(16rem,26rem)_minmax(0,1fr)]' : ''}`}>
                      <Show when={side()}>
                        <aside ref={pin} class="min-w-0 text-fg-2 @4xl:sticky @4xl:self-start">
                          <Show when={s.attention === 'changed'}>
                            <p class="text-fg-3">New or changed since Claude last wrote the guide, so it doesn’t explain these yet.</p>
                          </Show>
                          <Show when={s.explanation}>
                            <Markdown text={s.explanation!} />
                          </Show>
                        </aside>
                      </Show>
                      <div ref={(el) => side() && pin(el)} class="min-w-0 space-y-2 @4xl:sticky @4xl:self-start">
                        <For each={s.hunks}>
                          {(p) => {
                            const rows = createMemo(() => rowsOf(p.hunk.patch))
                            const id = p.hunk.id
                            return (
                              <HunkView
                                ref={(el) => {
                                  hunkEls.set(id, el)
                                  if (id === spot?.hunk) queueMicrotask(tryRestore)
                                }}
                                file={p.file}
                                rows={rows()}
                                open={isOpen(id)}
                                viewed={isViewed(id)}
                                comments={saved().comments.filter((c) => c.path === p.file.path)}
                                questions={saved().questions.filter((q) => q.path === p.file.path)}
                                answers={answers()}
                                running={props.running}
                                draft={draft()?.hunk === id ? draft() : undefined}
                                draftText={draftText()}
                                canAsk={!!props.onSend}
                                onToggle={() => setOpen((o) => ({ ...o, [id]: !isOpen(id) }))}
                                onViewed={(on) => setViewed([id], on)}
                                onLine={(at, extend) => startDraft(id, at, extend)}
                                onSpan={(anchor, at, picking) => spanDraft(id, anchor, at, picking)}
                                onDraftText={setDraftText}
                                onComment={() => saveComment(rows(), p.file.path)}
                                onAsk={() => ask(rows(), p.file.path)}
                                onCancel={closeDraft}
                                onEdit={(c) => {
                                  const from = rows().findIndex((r) => r.kind !== 'hunk' && anchorOf(r) === c.from)
                                  const to = rows().findIndex((r) => r.kind !== 'hunk' && anchorOf(r) === c.to)
                                  setDraft({ hunk: id, from: Math.max(from, 0), to: Math.max(to, 0), id: c.id })
                                  setDraftText(c.text)
                                }}
                                onRemove={removeComment}
                                onRemoveQuestion={removeQuestion}
                              />
                            )
                          }}
                        </For>
                      </div>
                    </div>
                  </section>
                )
              }}
            </For>
          </div>
        </div>
      </div>

      {/* What goes back to Claude */}
      <div class="shrink-0 space-y-2 border-t border-line px-3 py-2.5">
        <textarea
          value={saved().general}
          onInput={(e) => {
            const general = e.currentTarget.value
            update((s) => ({ ...s, general }))
          }}
          placeholder="Overall comment (optional)"
          // Grows with what's typed, as the composer does.
          class={`${inputClass} h-auto max-h-[calc(8lh+0.75rem)] resize-none py-1.5 [field-sizing:content]`}
        />
        <div class="flex flex-wrap items-center gap-2">
          <Button primary disabled={!props.onSend || (!saved().comments.length && !saved().general.trim())} onClick={send}>
            {saved().comments.length ? `Send ${plural(saved().comments.length, 'comment')}` : 'Send to Claude'}
          </Button>
          <span class="text-xs text-fg-3">Click a line’s + to comment or ask; shift-click another to cover the lines between. Claude acts on comments, then updates the guide.</span>
        </div>
      </div>
    </div>
    </LiveChatContext.Provider>
    </TranscriptIndex.Provider>
  )
}

const ATTENTION_DOT = { high: 'bg-danger', medium: 'bg-accent', low: 'bg-fg-3/60', changed: 'bg-primary' } as const
const ATTENTION_LABEL = { high: 'Read carefully', medium: 'Worth reading', low: 'Skim', changed: 'Not in the guide' } as const
const ATTENTION_BADGE = {
  high: 'bg-danger/10 text-danger',
  medium: 'bg-accent/10 text-accent',
  low: 'bg-surface text-fg-3',
  changed: 'bg-primary/10 text-primary',
} as const

function AttentionDot(props: { attention?: Section['attention'] }) {
  return <span class={`size-1.5 shrink-0 rounded-full ${props.attention ? ATTENTION_DOT[props.attention] : 'bg-line'}`} />
}

function AttentionBadge(props: { attention?: Section['attention'] }) {
  return (
    <Show when={props.attention}>
      {(a) => <span class={`shrink-0 rounded-full px-2 py-0.5 text-xs ${ATTENTION_BADGE[a()]}`}>{ATTENTION_LABEL[a()]}</span>}
    </Show>
  )
}

const STATUS_LETTER = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R' } as const
const STATUS_TONE = { added: 'text-ok', modified: 'text-fg-3', deleted: 'text-danger', renamed: 'text-accent' } as const

function HunkView(props: {
  ref: (el: HTMLElement) => void
  file: ReviewFile
  rows: Row[]
  open: boolean
  viewed: boolean
  /** The file's; each shows under its last line, if that's in this hunk. */
  comments: Note[]
  questions: Question[]
  answers: Map<string, Answer>
  running: boolean
  draft?: Draft
  draftText: string
  canAsk: boolean
  onToggle: () => void
  onViewed: (on: boolean) => void
  onLine: (at: number, extend: boolean) => void
  onSpan: (anchor: number, at: number, picking: boolean) => void
  onDraftText: (text: string) => void
  onComment: () => void
  onAsk: () => void
  onCancel: () => void
  onEdit: (c: Note) => void
  onRemove: (id: string) => void
  onRemoveQuestion: (id: string) => void
}) {
  const f = () => props.file
  const context = () => (props.rows[0]?.kind === 'hunk' ? props.rows[0].text : '')
  const startLine = () => props.rows.find((r): r is Line => r.kind !== 'hunk')?.new
  const [shown, setShown] = createSignal(false)
  const nothing = () => !props.rows.length
  const folded = () => f().generated && !shown()
  // Highlighted once it's open and near the screen, so a long review only highlights what's looked at.
  const [near, setNear] = createSignal(false)
  let box!: HTMLDivElement
  onMount(() => {
    const seen = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && (setNear(true), seen.disconnect()), { rootMargin: '800px' })
    seen.observe(box)
    onCleanup(() => seen.disconnect())
  })
  const [html] = createResource(
    () => near() && props.open && !folded() && props.rows.length > 0 && { rows: props.rows, lang: languageOf(f().path) },
    async ({ rows, lang }) => ({ rows, lines: await highlightRows(rows, lang) }),
  )
  // What changed, drawn as shapes behind the text once the rows are on the page, and again whenever they move.
  const [body, setBody] = createSignal<HTMLDivElement>()
  let marks: SVGSVGElement | undefined
  const codeEls: HTMLElement[] = []
  let queued = 0
  const draw = () => {
    queued = 0
    const el = body()
    if (!el || !marks || !el.isConnected) return
    const at = el.getBoundingClientRect()
    const half = parseFloat(getComputedStyle(el).lineHeight) / 2 || 10
    const boxes: Record<'add' | 'del', Box[]> = { add: [], del: [] }
    props.rows.forEach((r, i) => {
      // Lines being picked for a comment, or selected, show only that, rather than its colour mixing with theirs.
      const picking = (props.draft && i >= props.draft.from && i <= props.draft.to) || (selectedRows() && i >= selectedRows()![0] && i <= selectedRows()![1])
      if (r.kind === 'hunk' || r.kind === 'ctx' || picking || !r.marks?.length || !codeEls[i]?.isConnected) return
      for (const m of r.marks) {
        for (const b of textBoxes(codeEls[i], m)) {
          if (!b.width) continue
          // As tall as the line, not the text, so marks on lines one under another meet.
          const mid = (b.top + b.bottom) / 2 - at.top
          boxes[r.kind].push({ l: b.left - at.left - 1, r: b.right - at.left + 1, t: mid - half, b: mid + half })
        }
      }
    })
    // The lines a comment is being written on, like an editor's whole-line selection: from the start of the code to the end of
    // each line's text, at least a character wide so a blank line in it doesn't break it up.
    const picked: Box[] = []
    const d = props.draft
    if (d) {
      const ch = parseFloat(getComputedStyle(el).fontSize) * 0.6
      for (let i = d.from; i <= d.to; i++) {
        const code = codeEls[i]
        const r = props.rows[i]
        if (!code?.isConnected || !r || r.kind === 'hunk') continue
        const start = code.getBoundingClientRect()
        const lines = r.text.trimEnd() ? textBoxes(code, [0, r.text.trimEnd().length]) : []
        // A blank line by its row, since an empty span measures as nothing at the baseline.
        if (!lines.length) {
          const row = code.closest('[data-row]')?.getBoundingClientRect()
          lines.push(new DOMRect(start.left, row ? row.top : start.top, ch, row ? half * 2 : start.height))
        }
        for (const b of lines) {
          const mid = (b.top + b.bottom) / 2 - at.top
          picked.push({ l: start.left - at.left - 3, r: Math.max(b.right, start.left + ch) - at.left + 3, t: mid - half, b: mid + half })
        }
      }
    }
    // Text selected the ordinary way, drawn like the rest rather than by the browser: the part of it in this hunk's code,
    // character by character, leaving out the line numbers and signs a selection runs through on its way.
    const chosen: Box[] = []
    const range = selection()
    if (range) {
      const code = codeEls.find((c) => c?.isConnected)?.getBoundingClientRect()
      for (const b of range.getClientRects()) {
        if (!b.width || !code || b.left < code.left - 1 || b.bottom < at.top || b.top > at.bottom) continue
        const mid = (b.top + b.bottom) / 2 - at.top
        chosen.push({ l: b.left - at.left, r: b.right - at.left, t: mid - half, b: mid + half })
      }
    }
    marks.innerHTML = [
      ...(
        [
          ['add', '--color-ok'],
          ['del', '--color-danger'],
        ] as const
      ).map(([kind, colour]) => `<path d="${blobs(boxes[kind], 4)}" style="fill: var(${colour}); opacity: 0.28" />`),
      picked.length ? `<path d="${blobs(picked, 5)}" style="fill: var(--color-accent); opacity: 0.3" />` : '',
      chosen.length ? `<path d="${blobs(chosen, 4)}" style="fill: var(--color-accent); opacity: 0.3" />` : '',
    ].join('')
  }

  /** The page's text selection while some of it is in this hunk; where to offer commenting on it, once it's been made. */
  const [selection, setSelection] = createSignal<Range>()
  const [offer, setOffer] = createSignal<{ from: number; to: number; x: number; y: number }>()
  /** The rows of this hunk the selection covers, from..to: all of them past whichever end of it is outside. */
  const selectedRows = (): [number, number] | undefined => {
    const range = selection()
    const el = body()
    if (!range || !el) return
    const start = rowOf(range.startContainer)
    const end = rowOf(range.endContainer)
    return [start && el.contains(start) ? Number(start.dataset.row) : 0, end && el.contains(end) ? Number(end.dataset.row) : props.rows.length - 1]
  }
  const rowOf = (n: Node) => (n.nodeType === Node.TEXT_NODE ? n.parentElement : (n as Element))?.closest<HTMLElement>('[data-row]')
  const onSelectionChange = () => {
    const el = body()
    const sel = getSelection()
    const range = el && sel && !sel.isCollapsed && sel.rangeCount ? sel.getRangeAt(0) : undefined
    const here = el && range && range.intersectsNode(el) ? range : undefined
    if (!here && !selection()) return
    setSelection(here?.cloneRange())
    if (!here) setOffer(undefined)
    redraw()
  }
  // Offered once the mouse lets go, for a selection that starts and ends in this hunk's lines.
  const onSelected = () => {
    const el = body()
    const range = selection()
    const from = range && rowOf(range.startContainer)
    const to = range && rowOf(range.endContainer)
    if (!el || !range || !from || !to || !el.contains(from) || !el.contains(to)) return setOffer(undefined)
    const end = [...range.getClientRects()].filter((b) => b.width).at(-1)
    const at = el.getBoundingClientRect()
    if (end) setOffer({ from: Number(from.dataset.row), to: Number(to.dataset.row), x: end.right - at.left, y: end.bottom - at.top })
  }
  onMount(() => {
    document.addEventListener('selectionchange', onSelectionChange)
    document.addEventListener('pointerup', onSelected)
    onCleanup(() => {
      document.removeEventListener('selectionchange', onSelectionChange)
      document.removeEventListener('pointerup', onSelected)
    })
  })
  const commentOnSelection = () => {
    const o = offer()
    if (!o) return
    getSelection()?.removeAllRanges()
    setOffer(undefined)
    props.onSpan(o.from, o.to, false)
  }
  const redraw = () => {
    if (!queued) queued = requestAnimationFrame(draw)
  }
  createEffect(on(() => props.draft, redraw, { defer: true }))
  createEffect(() => {
    const el = body()
    if (!el) return
    const resized = new ResizeObserver(redraw)
    resized.observe(el)
    onCleanup(() => resized.disconnect())
  })

  /** Only for the rows it was made from: while new rows are highlighted, the last ones' lines would be out of step. */
  /**
   * Pressing on a line's + or numbers picks it for a comment, and dragging up or down picks the lines between, scrolling
   * the page near its edges; the box to write in opens when it's let go. Shift picks from the last line picked, as before.
   */
  const pickFrom = (e: PointerEvent, at: number) => {
    if (e.button !== 0) return
    e.preventDefault()
    if (e.shiftKey) return props.onLine(at, true)
    let to = at
    props.onSpan(at, at, true)
    const page = body()?.closest('.overflow-y-auto')
    const move = (ev: PointerEvent) => {
      const row = (document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null)?.closest<HTMLElement>('[data-row]')
      if (row && body()?.contains(row) && Number(row.dataset.row) !== to) props.onSpan(at, (to = Number(row.dataset.row)), true)
      if (page) {
        const edge = page.getBoundingClientRect()
        if (ev.clientY < edge.top + 60) page.scrollBy(0, -20)
        else if (ev.clientY > edge.bottom - 40) page.scrollBy(0, 20)
      }
    }
    const up = () => {
      removeEventListener('pointermove', move)
      removeEventListener('pointerup', up)
      removeEventListener('pointercancel', up)
      props.onSpan(at, to, false)
    }
    addEventListener('pointermove', move)
    addEventListener('pointerup', up)
    addEventListener('pointercancel', up)
  }

  const lineHtml = (i: number) => (html()?.rows === props.rows ? html()!.lines?.[i] : undefined)

  return (
    // Off-screen hunks skip layout and paint until they come near, with a guess at their height until they've been drawn once.
    <div
      ref={(el) => {
        box = el
        props.ref(el)
      }}
      style={{ 'content-visibility': 'auto', 'contain-intrinsic-size': `auto ${Math.min(props.rows.length, 400) * 20 + 30}px` }}
      class={`scroll-mt-14 overflow-hidden rounded-lg border ${props.viewed ? 'border-line/60' : 'border-line'}`}>
      <div class="flex items-center gap-2 bg-surface/60 px-2 py-1">
        <button onClick={props.onToggle} class="grid size-5 shrink-0 place-items-center rounded text-fg-3 hover:bg-surface hover:text-fg-2">
          {props.open ? <ChevronDown class="size-3.5" /> : <ChevronRight class="size-3.5" />}
        </button>
        <span class={`shrink-0 font-mono text-xs ${STATUS_TONE[f().status]}`}>{STATUS_LETTER[f().status]}</span>
        <button onClick={props.onToggle} class="min-w-0 truncate text-left font-mono text-xs text-fg" title={f().path} dir="rtl">
          {/* rtl so a long path loses its start, not its file name. */}
          <bdi>
            {f().oldPath ? `${f().oldPath} → ${f().path}` : f().path}
            <Show when={startLine()}>:{startLine()}</Show>
          </bdi>
        </button>
        <Show when={context()}>
          <span class="hidden min-w-0 truncate font-mono text-xs text-fg-3 @2xl:block">{context()}</span>
        </Show>
        <div class="flex-1" />
        <label class="flex shrink-0 cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-xs text-fg-3 hover:bg-surface hover:text-fg-2">
          <input type="checkbox" checked={props.viewed} onChange={(e) => props.onViewed(e.currentTarget.checked)} class="accent-(--color-primary)" />
          Viewed
        </label>
      </div>

      <Show when={props.open}>
        <Show
          when={!nothing() && !folded()}
          fallback={
            <p class="px-4 py-2 text-xs text-fg-3">
              {f().binary
                ? 'Binary file.'
                : f().truncated
                  ? 'Too big to show here.'
                  : folded()
                    ? 'Generated file, folded. '
                    : f().status === 'renamed'
                      ? 'Renamed, with no changes to its lines.'
                      : 'No lines changed.'}
              <Show when={folded()}>
                <button onClick={() => setShown(true)} class="underline-offset-2 hover:text-fg-2 hover:underline">
                  Show it
                </button>
              </Show>
            </p>
          }
        >
          {/* Its own stacking context, so the marks can go under the rows' text but stay above the page. */}
          {/* The browser's own selection colour is hidden here: the selection is drawn with the marks, as a shape. */}
          <div ref={setBody} class="relative isolate font-mono text-xs leading-5 selection:bg-transparent">
            <svg ref={marks} class="pointer-events-none absolute inset-0 -z-10 size-full overflow-visible" aria-hidden="true" />
            <Show when={offer()}>
              {(o) => (
                <button
                  onPointerDown={(e) => e.preventDefault()}
                  onClick={commentOnSelection}
                  style={{ left: `${Math.max(0, o().x - 40)}px`, top: `${o().y + 4}px` }}
                  class="absolute z-10 flex items-center gap-1 rounded-md bg-primary px-2 py-1 font-sans text-xs text-on-primary shadow-(--shadow-pop)"
                >
                  <MessageSquarePlus class="size-3" /> Comment
                </button>
              )}
            </Show>
            <For each={props.rows}>
              {(r, i) => {
                if (r.kind === 'hunk') return null
                const anchor = anchorOf(r)
                const comments = () => props.comments.filter((c) => c.to === anchor)
                const questions = () => props.questions.filter((q) => q.to === anchor)
                const editing = () => props.draft && !props.draft.picking && props.draft.to === i()
                return (
                  <>
                    <div
                      data-row={i()}
                      class={`group relative flex ${r.kind === 'add' ? 'bg-ok/10' : r.kind === 'del' ? 'bg-danger/10' : ''}`}
                    >
                      <span onPointerDown={(e) => pickFrom(e, i())} class="flex shrink-0 cursor-pointer select-none">
                        <span class="w-10 pr-1.5 text-right text-fg-3/70 tabular-nums">{r.old ?? ''}</span>
                        <span class="w-10 pr-1.5 text-right text-fg-3/70 tabular-nums">{r.new ?? ''}</span>
                      </span>
                      <button
                        onPointerDown={(e) => pickFrom(e, i())}
                        // A click from the keyboard; a pointer's is handled as it goes down.
                        onClick={(e) => e.detail === 0 && props.onLine(i(), e.shiftKey)}
                        title="Comment on or ask about this line: drag to cover more, or shift-click another"
                        class="absolute left-0.5 top-0.5 grid size-4 place-items-center rounded bg-primary text-on-primary opacity-0 group-hover:opacity-100 pointer-coarse:opacity-40"
                      >
                        <MessageSquarePlus class="size-2.5" />
                      </button>
                      <span class={`w-4 shrink-0 select-none text-center ${r.kind === 'add' ? 'text-ok' : r.kind === 'del' ? 'text-danger' : 'text-fg-3'}`}>{SIGN[r.kind]}</span>
                      <span class="min-w-0 flex-1 whitespace-pre-wrap break-all pr-3 text-fg">
                        <Code line={r} html={lineHtml(i())} ref={(el) => (codeEls[i()] = el)} onDrawn={redraw} />
                      </span>
                    </div>
                    <Show when={editing()}>
                      <DraftBox
                        text={props.draftText}
                        editing={!!props.draft?.id}
                        lines={props.draft!.to - props.draft!.from + 1}
                        canAsk={props.canAsk}
                        onText={props.onDraftText}
                        onComment={props.onComment}
                        onAsk={props.onAsk}
                        onCancel={props.onCancel}
                      />
                    </Show>
                    <For each={questions()}>
                      {(q) => <QuestionBox question={q} answer={props.answers.get(q.id)} onRemove={() => props.onRemoveQuestion(q.id)} />}
                    </For>
                    <For each={comments()}>
                      {(c) => (
                        <Show when={props.draft?.id !== c.id}>
                          <CommentBox note={c} onEdit={() => props.onEdit(c)} onRemove={() => props.onRemove(c.id)} />
                        </Show>
                      )}
                    </For>
                  </>
                )
              }}
            </For>
          </div>
        </Show>
      </Show>
    </div>
  )
}

/**
 * Each row's line highlighted, by index into the rows: removed lines from the old side, the rest from the new. Each side is
 * highlighted whole, so a string or comment that spans lines is still one. Undefined until it's done, or for a language
 * there's no grammar for.
 */
async function highlightRows(rows: Row[], lang: string | undefined): Promise<(string | undefined)[] | undefined> {
  const lines = rows.filter((r): r is Line => r.kind !== 'hunk')
  const side = (kind: Line['kind']) => lines.filter((r) => r.kind === 'ctx' || r.kind === kind).map((r) => r.text).join('\n')
  const [before, after] = await Promise.all([highlight(side('del'), lang), highlight(side('add'), lang)])
  if (before === undefined || after === undefined) return
  const old = before.split('<br>')
  const now = after.split('<br>')
  let o = 0
  let n = 0
  return rows.map((r) => {
    if (r.kind === 'hunk') return
    if (r.kind === 'del') return old[o++]
    if (r.kind === 'ctx') o++
    return now[n++]
  })
}

/** A line, highlighted once that's done. What changed in it is drawn behind it, by its hunk (see blobs). */
function Code(props: { line: Line; html?: string; ref: (el: HTMLElement) => void; onDrawn: () => void }) {
  let el!: HTMLSpanElement
  // Filled by hand rather than by Solid, since highlighting replaces what's inside.
  createEffect(() => {
    // A space for an empty line, so it's a line's height like the rest.
    if (props.html) el.innerHTML = props.html
    else el.textContent = props.line.text || ' '
    props.onDrawn()
  })
  return (
    <span
      ref={(e) => {
        el = e
        props.ref(e)
      }}
    />
  )
}

const boxClass = 'mx-3 my-1.5 rounded-lg border px-3 py-2 font-sans text-ui'

function DraftBox(props: {
  text: string
  editing: boolean
  lines: number
  canAsk: boolean
  onText: (t: string) => void
  onComment: () => void
  onAsk: () => void
  onCancel: () => void
}) {
  let el!: HTMLTextAreaElement
  onMount(() => el.focus())
  return (
    <div class={`${boxClass} border-accent/40 bg-bg`}>
      <textarea
        ref={el}
        value={props.text}
        onInput={(e) => props.onText(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) props.onComment()
          if (e.key === 'Escape') props.onCancel()
        }}
        placeholder={props.lines > 1 ? `On these ${props.lines} lines…` : 'On this line…'}
        // Grows with what's typed, as the composer does.
        class="block max-h-[12lh] min-h-[3lh] w-full resize-none bg-transparent text-ui outline-none [field-sizing:content] placeholder:text-fg-3"
      />
      <div class="mt-1 flex flex-wrap items-center gap-2">
        <Button primary onClick={props.onComment} class="h-7 text-xs" title="Kept with your other comments, to send together for Claude to act on">
          {props.editing ? 'Save' : 'Add comment'}
        </Button>
        <Show when={!props.editing}>
          <Button onClick={props.onAsk} disabled={!props.canAsk} class="flex h-7 items-center gap-1 text-xs" title="Sent now; Claude's answer shows here">
            Ask Claude
          </Button>
        </Show>
        <Button onClick={props.onCancel} class="h-7 text-xs">
          Cancel
        </Button>
        <span class="text-xs text-fg-3">⌘/Ctrl+Enter to add</span>
      </div>
    </div>
  )
}

function CommentBox(props: { note: Note; onEdit?: () => void; onRemove: () => void }) {
  return (
    <div class={`${boxClass} group/c border-line bg-surface`}>
      <div class="mb-0.5 flex items-center gap-2 text-xs text-fg-3">
        <span>
          Your comment · {props.note.path.split('/').pop()}, {props.note.where}
        </span>
        <div class="flex-1" />
        <Show when={props.onEdit}>
          <button onClick={props.onEdit} class="opacity-0 hover:text-fg-2 group-hover/c:opacity-100">
            Edit
          </button>
        </Show>
        <button onClick={props.onRemove} title="Delete" class="opacity-0 hover:text-danger group-hover/c:opacity-100">
          <Trash2 class="size-3" />
        </button>
      </div>
      <p class="whitespace-pre-wrap text-fg">{props.note.text}</p>
    </div>
  )
}

/** A question and Claude's answer, shown as the conversation shows a turn: its work folded once done, its reply as it streams. */
function QuestionBox(props: { question: Question; answer?: Answer; onRemove: () => void }) {
  const live = useContext(LiveChatContext)!
  const answering = () => !!props.answer?.latest && live.running()
  return (
    // Never what the page keeps still as it scrolls: an answer changes height as it streams and folds, and the lines around
    // it shouldn't move for that.
    <div class={`${boxClass} group/q border-accent/30 bg-accent/5 [overflow-anchor:none]`}>
      <div class="mb-0.5 flex items-center gap-2 text-xs text-fg-3">
        <span>You asked</span>
        <div class="flex-1" />
        <button onClick={props.onRemove} title="Remove from the diff (it stays in the conversation)" class="opacity-0 hover:text-fg-2 group-hover/q:opacity-100">
          <Trash2 class="size-3" />
        </button>
      </div>
      <p class="whitespace-pre-wrap text-fg">{props.question.text}</p>
      <div class="mt-2 border-t border-accent/20 pt-1 text-fg-2">
        <Show
          when={props.answer}
          fallback={
            <span class="flex items-center gap-2 py-1 text-xs text-fg-3">
              <LiveDot /> Waiting to go in
            </span>
          }
        >
          {(a) => (
            <Show when={a().messages.length || answering()} fallback={<span class="text-xs text-fg-3">No answer.</span>}>
              <Messages
                messages={a().messages}
                partial={a().latest ? live.partial() : null}
                bashOutput={live.bashOutput()}
                running={answering()}
                working={answering()}
                cwd={live.cwd()}
                children={live.children()}
                nested
                folded
              />
            </Show>
          )}
        </Show>
      </div>
    </div>
  )
}
