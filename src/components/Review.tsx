import { For, Show, createContext, createEffect, createMemo, createResource, createSignal, on, onCleanup, onMount, untrack, useContext, type JSX } from 'solid-js'
import { createStore } from 'solid-js/store'
import { Check, ChevronDown, ChevronRight, FileText, MessageSquarePlus, RotateCw, Trash2 } from '../icons'
import type { ReviewAttention, ReviewDiff, ReviewFile, ReviewGroup, ReviewGuide, ReviewHunk, WireMessage } from '../../shared/protocol.ts'
import { api } from '../api.ts'
import { SIGN, anchorOf, rowsFor, startOf, type Line, type Row } from '../diffRows.ts'
import { plural } from '../format.ts'
import { highlight, languageOf } from '../highlight.ts'
import { recall, remember, settle } from '../scrollMemory.ts'
import { TranscriptIndex } from '../transcript/context.ts'
import { itemsFor, type Block, type Index } from '../transcript/model.ts'
import type { Partial as Streaming } from '../useChat.ts'
import { Messages } from './Transcript.tsx'
import { BasePicker, baseChanged, howText } from './BasePicker.tsx'
import { useOpenFile } from '../fileLinks.ts'
import { CodeRow } from './CodeRow.tsx'
import { Markdown } from './Markdown.tsx'
import { Button, DiffCount, GhostButton, LiveDot, PaneBar, PathLabel, inputClass } from './ui.tsx'

/*
 * SPIKE: a checkout's changes, every hunk. Two ways: a chat's diff, in a panel beside it, file by file; or a guided
 * review, a chat of its own whose page this is, in the groups and order of the guide Claude writes for them
 * (review_guide_group, then review_guide_done), each group with what a reader needs to follow it. Either way you
 * tick hunks off as you read, ask about lines (Claude answers beside them), and send comments for Claude to act on;
 * in a guided review, it then updates the guide. What's kept (viewed hunks, comments, questions) is in
 * localStorage, per chat and way.
 */

const GROUP_TOOL = 'review_guide_group'
const DONE_TOOL = 'review_guide_done'

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
/** By chat, and whether it's a guided review or a chat's diff, so a chat's diff and its review don't share. */
const storeKey = (session: string, guided: boolean) => `badger.${guided ? 'review2' : 'diff'}.${session}`

function useReview(session: string, guided: boolean) {
  const key = storeKey(session, guided)
  let s = stores.get(key)
  if (!s) {
    let initial = EMPTY
    try {
      initial = { ...EMPTY, ...JSON.parse(localStorage.getItem(key) ?? '{}') }
    } catch {}
    stores.set(key, (s = createSignal<Saved>(initial)))
  }
  const [saved, setSaved] = s
  // Written once typing pauses, not on every keystroke.
  let timer: ReturnType<typeof setTimeout> | undefined
  const update = (f: (s: Saved) => Saved) => {
    setSaved(f)
    clearTimeout(timer)
    timer = setTimeout(() => localStorage.setItem(key, JSON.stringify(saved())), 300)
  }
  return { saved, update }
}

const NO_NOTES: Note[] = []
const NO_QUESTIONS: Question[] = []
const byPath = <T extends Note>(notes: T[]) => {
  const out = new Map<string, T[]>()
  for (const n of notes) out.set(n.path, [...(out.get(n.path) ?? []), n])
  return out
}

// ── Marks drawn as one shape ──

/** A range less another: what's left either side of it. */
function without([from, to]: [number, number], [cutFrom, cutTo]: [number, number]): [number, number][] {
  if (cutTo <= from || cutFrom >= to) return [[from, to]]
  return ([[from, Math.min(to, cutFrom)], [Math.max(from, cutTo), to]] as [number, number][]).filter(([f, t]) => t > f)
}

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

/** Which of Badger's guide tools a call is, if it is one: another MCP server's tool of the same name isn't. */
const guideCall = (name?: string) => [GROUP_TOOL, DONE_TOOL].find((t) => name === `mcp__badger__${t}`)

/** The guide calls and how each went, as a string: the guide only needs working out again when this changes. */
function guideCalls(index: Index): string {
  let key = ''
  for (const m of index.groups.get('') ?? []) {
    // A turn ending counts too: a call it left without a result was never going to get one.
    if (m.type === 'result') key += '| '
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
 * says it's whole. `writing`: a call
 * is out, or groups have come since the last done.
 */
function guideOf(index: Index): { guide?: ReviewGuide; writing: boolean } {
  let order: string[] = []
  const groups = new Map<string, ReviewGroup>()
  let summary = ''
  let done = false
  let pending = false
  for (const m of index.groups.get('') ?? []) {
    // Only a call in the turn under way is still being made; one an ended turn left behind (a process killed) never will be.
    if (m.type === 'result') pending = false
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
  /** Where in its first line it starts and in its last it ends, as selected; whole lines when absent. */
  start?: number
  end?: number
}

export function ReviewPage(props: {
  /** The chat comments and questions go to: the review chat, or the chat a diff is beside. */
  sessionId: string
  /** A review chat's page, in its guide's groups; otherwise a chat's diff, file by file. */
  guided: boolean
  /** Where git runs. */
  cwd?: string
  machine: string
  index: () => Index
  /** Read again when a turn ends, since that's when files change. */
  running: boolean
  /** Sends a message to the chat; absent when it can't take one. */
  onSend?: (text: string) => void
  /** A chat's diff: starts a guided review of the changes, or opens the one there is. */
  onGuide?: () => void
  /** In a panel: how to focus it. */
  onReady?: (focus: () => void) => void
  /** Put first in the toolbar's row, e.g. a review chat's tabs. */
  lead?: JSX.Element
  /** The toolbar's row is the second line of the chat's header (see PaneBar). */
  underHeader?: boolean
  /** Only this file's changes, by its path in the checkout: a file's own diff. */
  only?: string
  /**
   * With `only`: all of the file, its changes in place, as one hunk rather than split up. Nothing to tick off as viewed,
   * since that's done hunk by hunk in the chat's diff, and the file's toolbar is above it, so no header of its own.
   */
  whole?: boolean
  /** What's streaming in, for answers to show as the conversation does. */
  partial: Streaming | null
  bashOutput: Record<string, string>
  children?: Record<string, string>
}) {
  const { saved, update } = useReview(
    untrack(() => props.sessionId),
    untrack(() => props.guided),
  )
  const openFile = useOpenFile()
  const [diff, setDiff] = createSignal<ReviewDiff>()
  /** Opens a file of the changes whole, at a line if given; not one that's been deleted, which has nothing to show. */
  const openerFor = (f: ReviewFile) => {
    const root = diff()?.root
    if (!openFile || !root || f.status === 'deleted') return
    return (line?: number) => openFile.open(`${root}/${f.path}`, line)
  }
  const [error, setError] = createSignal<string>()
  const [loading, setLoading] = createSignal(false)
  /** Hunks opened or folded by hand, overriding whether they're viewed. */
  const [open, setOpen] = createStore<Record<string, boolean>>({})
  const [draft, setDraft] = createSignal<Draft>()
  const [draftText, setDraftText] = createSignal('')

  let seq = 0
  const load = async () => {
    const dir = props.cwd
    if (!dir) return
    const mine = ++seq
    setLoading(true)
    try {
      const whole = props.whole && props.only
      // All of it is as much context as there is.
      const next = await api.review(dir, 'base', whole ? 100_000 : 3, props.machine, whole || undefined)
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
  createEffect(on(baseChanged, () => void load(), { defer: true }))

  // Worked out again only when a guide call comes or finishes, not on every message.
  // A chat's diff has none: the chat it's beside wasn't asked for one.
  const told = createMemo(
    on(
      createMemo(() => (props.guided ? guideCalls(props.index()) : '')),
      () => (props.guided ? guideOf(untrack(props.index)) : { writing: false }),
    ),
  )
  const guide = () => told().guide
  // Each part of what's kept on its own, so typing an overall comment or ticking a hunk doesn't redo the rest.
  const comments = createMemo(() => saved().comments)
  const questions = createMemo(() => saved().questions)
  const commentsIn = createMemo(() => byPath(comments()))
  const questionsIn = createMemo(() => byPath(questions()))
  const answers = createMemo(() => answersOf(props.index(), questions()))

  // Kept the same where a hunk is, so reading the diff again (each time a turn ends) doesn't redraw what hasn't changed.
  /** What's shown of the changes: all of them, or one file's. */
  const files = createMemo(() => (diff()?.files ?? []).filter((f) => !props.only || f.path === props.only))
  const placed = createMemo<Map<string, Placed>>((before) => {
    const all = new Map<string, Placed>()
    for (const file of files()) {
      for (const hunk of file.hunks) {
        const was = before?.get(hunk.id)
        const same = was && was.hunk.patch === hunk.patch && was.file.path === file.path && was.file.status === file.status && was.file.oldPath === file.oldPath
        all.set(hunk.id, same ? was : { file, hunk })
      }
    }
    return all
  })
  // A comment being written on lines Claude has since changed has no hunk to show under any more: what was written goes
  // into the overall comment, rather than being lost.
  createEffect(
    on(placed, (all) => {
      const d = untrack(draft)
      if (!d || !diff() || all.has(d.hunk)) return
      const text = untrack(draftText).trim()
      if (text) update((x) => ({ ...x, general: [x.general.trim(), `On lines that have since changed: ${text}`].filter(Boolean).join('\n\n') }))
      setDraft(undefined)
      setDraftText('')
    }),
  )
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
      out = files().map((f) => ({ id: `file:${f.path}`, title: f.path, hunks: f.hunks.map((hunk) => all.get(hunk.id)!) }))
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
  const isOpen = (id: string) => open[id] ?? !isViewed(id)
  const setViewed = (ids: string[], on: boolean) => {
    update((s) => ({ ...s, viewed: on ? [...new Set([...s.viewed, ...ids])] : s.viewed.filter((v) => !ids.includes(v)) }))
    setOpen(Object.fromEntries(ids.map((id) => [id, !on])))
  }

  // ── Comments and questions ──

  /** A new comment on what's selected: lines from..to of a hunk, from `start` in the first to `end` in the last. */
  const selectDraft = (hunk: string, from: number, to: number, start?: number, end?: number) => {
    if (draft()?.hunk !== hunk || draft()?.id) setDraftText('')
    setDraft({ hunk, from, to, start, end })
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
    setWriting(false)
  }

  /** A comment on the whole being started, before anything's typed. */
  const [writing, setWriting] = createSignal(false)
  const commenting = () => writing() || comments().length > 0 || !!saved().general.trim()
  let generalBox: HTMLTextAreaElement | undefined
  const startComment = () => {
    setWriting(true)
    queueMicrotask(() => generalBox?.focus())
  }

  /** Comments whose lines aren't in any hunk now, e.g. after Claude changed them. */
  const shown = createMemo(() => {
    const out = new Set<string>()
    for (const p of placed().values()) for (const r of rowsFor(p.hunk)) if (r.kind !== 'hunk') out.add(`${p.file.path}:${anchorOf(r)}`)
    return out
  })
  // Only the files shown: a file's own diff isn't where the rest of the chat's comments belong.
  const loose = createMemo(() => comments().filter((c) => (!props.only || c.path === props.only) && !shown().has(`${c.path}:${c.to}`)))

  const sectionEls = new Map<string, HTMLElement>()
  const hunkEls = new Map<string, HTMLElement>()
  /** To a hunk, or, folded into its file's box with no bar of its own to show, to the box. */
  const jumpTo = (el?: HTMLElement) => (el && !el.offsetParent ? el.closest('section') : el)?.scrollIntoView({ block: 'start', behavior: 'smooth' })
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
  const scrollKey = `${untrack(() => props.guided) ? 'review' : 'diff'}:${untrack(() => props.sessionId)}${untrack(() => props.only) ? `:${untrack(() => props.only)}` : ''}`
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
    props.onReady?.(() => scroller.focus({ preventScroll: true }))
  })
  // Back to where it was read to, as soon as that hunk is on the page.
  const tryRestore = () => {
    if (restored || !spot) return
    if (diff() && !placed().has(spot.hunk)) return giveUp()
    if (!hunkEls.has(spot.hunk)) return
    restored = true
    requestAnimationFrame(() => {
      const stop = settle(scroller, content, () => {
        // A hunk folded away has no place on the page to measure: nothing to go back to.
        const el = hunkEls.get(spot.hunk)
        if (el?.offsetParent) scroller.scrollTop += el.getBoundingClientRect().top - (scroller.getBoundingClientRect().top + PINNED_TOP + 8) + spot.offset
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

  /** What the changes are against, how much of them, and what to do with them. Narrow, the words go and the icons stay. */
  const tools = () => (
    <div class="flex min-w-0 flex-1 items-center gap-3 text-xs whitespace-nowrap text-fg-3">
      <Show when={diff()}>
        {(d) => (
          <>
            {/* The branch is in the bar above; what it's compared with is the review's own. */}
            <Show when={props.cwd}>
              {(dir) => (
                <BasePicker
                  dir={dir()}
                  machine={props.machine}
                  title={d().base ? `Compared with ${d().base}, ${howText[d().baseHow ?? 'nearest']}. Pick another` : 'Pick a branch to compare with'}
                  triggerClass={(open) => `-mx-1.5 flex min-w-0 items-center gap-1 rounded-md px-1.5 py-0.5 transition-colors hover:bg-surface ${open ? 'bg-surface' : ''}`}
                  trigger={() => (
                    <>
                      <Show when={d().base} fallback="Uncommitted only">
                        <span class="hidden @md:inline">against </span>
                        <span class="min-w-0 truncate font-mono text-fg-2">{d().base}</span>
                      </Show>
                      <ChevronDown class="size-3 shrink-0" />
                    </>
                  )}
                />
              )}
            </Show>
            <DiffCount
              files={files().length}
              added={files().reduce((n, f) => n + f.added, 0)}
              removed={files().reduce((n, f) => n + f.removed, 0)}
              class="shrink-0"
            />
          </>
        )}
      </Show>
      <div class="flex-1" />
      <Show when={total() && !props.whole}>
        <span class="shrink-0 tabular-nums" title={`${viewedCount()} of ${plural(total(), 'hunk')} viewed`}>
          {viewedCount()}/{total()}
          <span class="hidden @md:inline"> viewed</span>
        </span>
      </Show>
      <div class="-mx-1.5 flex shrink-0 items-center">
        <Show when={!commenting()}>
          <GhostButton title="Comment on the changes as a whole. To comment on lines, select them." onClick={startComment}>
            <MessageSquarePlus class="size-3.5" />
          </GhostButton>
        </Show>
        <GhostButton title="Read the changes again" onClick={() => void load()}>
          <RotateCw class={`size-3.5 ${loading() ? 'animate-spin' : ''}`} />
        </GhostButton>
        <Show when={!props.whole && props.onGuide}>
          {(guide) => (
            <button
              onClick={guide()}
              disabled={!total()}
              class="flex h-7 items-center gap-1.5 rounded-md px-1.5 text-fg-2 transition-colors hover:bg-surface hover:text-fg disabled:opacity-50"
              title="Guided review: a chat of its own where Claude groups these changes, explains each group, and answers and acts on your comments"
            >
              Guided review
            </button>
          )}
        </Show>
      </div>
    </div>
  )

  return (
    <TranscriptIndex.Provider value={props.index}>
    <LiveChatContext.Provider value={live}>
    <div class="@container flex min-h-0 flex-1 flex-col text-ui">
      {/* After whatever leads it, like the review's tabs. */}
      <PaneBar underHeader={props.underHeader}>
        {props.lead}
        {tools()}
      </PaneBar>
      {/* How much has been viewed, as a line along the foot of what's above, over its edge but under the header's menus. */}
      <Show when={total() && !props.whole}>
        <div class="relative z-10 h-0">
          <div class="absolute inset-x-0 -top-0.5 h-0.5">
            <div class="h-full bg-ok transition-[width]" style={{ width: `${(viewedCount() / total()) * 100}%` }} />
          </div>
        </div>
      </Show>

      <div class="flex min-h-0 flex-1">
        <nav class={`hidden w-72 shrink-0 overflow-y-auto border-r border-line py-2 ${props.whole ? '' : '@6xl:block'}`}>
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

        {/* The diff, with what goes back to Claude under it; the outline beside them runs the full height. Its own
            layer, so its sticky headers stay under the bar's shadow above. */}
        <div class="flex min-w-0 flex-1 flex-col">
          <div ref={scroller} onScroll={onScroll} tabIndex={-1} class="isolate min-h-0 flex-1 overflow-y-auto outline-none">
            <div ref={content} class={props.whole ? 'pb-10' : 'mx-auto max-w-[100rem] px-2 pb-10 @3xl:px-4'}>
              <Show when={!diff() && loading()}>
                <p class="p-10 text-center text-fg-3">Reading the changes…</p>
              </Show>
              <Show when={error()}>
                <p class="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">{error()}</p>
              </Show>
              <Show
                when={guide()}
                fallback={
                  <Show when={props.guided && diff()}>
                    <p class="mt-3 flex items-center gap-2 px-1 text-fg-3">
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
                    <div class="mt-4 px-1 text-fg-2">
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
                  const ids = () => s.hunks.map((p) => p.hunk.id)
                  const allViewed = () => ids().every(isViewed)
                  const hunk = (p: Placed, bare?: { bar: boolean }) => {
                    const rows = () => rowsFor(p.hunk)
                    const id = p.hunk.id
                    return (
                      <HunkView
                        ref={(el) => {
                          hunkEls.set(id, el)
                          if (id === spot?.hunk) queueMicrotask(tryRestore)
                        }}
                        bare={bare}
                        file={p.file}
                        rows={rows()}
                        // All of a file is the whole page: nothing to unfold it by if it were folded.
                        open={props.whole || isOpen(id)}
                        viewed={isViewed(id)}
                        comments={commentsIn().get(p.file.path) ?? NO_NOTES}
                        questions={questionsIn().get(p.file.path) ?? NO_QUESTIONS}
                        answers={answers()}
                        running={props.running}
                        draft={draft()?.hunk === id ? draft() : undefined}
                        draftText={draftText()}
                        canAsk={!!props.onSend}
                        onToggle={() => setOpen(id, !isOpen(id))}
                        onOpen={openerFor(p.file)}
                        onViewed={(on) => setViewed([id], on)}
                        onSelect={(from, to, start, end) => selectDraft(id, from, to, start, end)}
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
                  }
                  const foldAll = () => {
                    const open = !ids().some(isOpen)
                    setOpen(Object.fromEntries(ids().map((id) => [id, open])))
                  }
                  const file = s.id.startsWith('file:') ? s.hunks[0]?.file : undefined
                  // As read last: a hunk that didn't change keeps the file it came with, and its counts from then.
                  const fresh = () => files().find((f) => f.path === file?.path) ?? file!
                  // All of one file: its one hunk edge to edge under the file's toolbar, as the File view has it.
                  if (file && props.whole)
                    return (
                      <section ref={(el) => sectionEls.set(s.id, el)} class="[&>div]:border-t-0">
                        <For each={s.hunks}>{(p) => hunk(p, { bar: false })}</For>
                      </section>
                    )
                  // File by file: the file is the one box, its hunks one after another in it, split by their @@ lines.
                  if (file)
                    return (
                      <section ref={(el) => sectionEls.set(s.id, el)} class="mt-3 scroll-mt-3 overflow-clip rounded-lg border border-line">
                        {/* Stuck to the top while the file is in view, so you know which one you're in. */}
                        <header class="sticky top-0 z-10 flex h-9 items-center gap-2 bg-surface px-2 text-xs">
                          <FoldButton open={ids().some(isOpen)} onClick={foldAll} />
                          <span class={`shrink-0 font-mono ${STATUS_TONE[file.status]}`}>{STATUS_LETTER[file.status]}</span>
                          <h2 class="flex min-w-0">
                            <button onClick={foldAll} class="flex min-w-0 text-left text-fg">
                              <PathLabel path={file.path} oldPath={file.oldPath} />
                            </button>
                          </h2>
                          <Show when={fresh().added || fresh().removed}>
                            <DiffCount files={1} added={fresh().added} removed={fresh().removed} class="shrink-0" />
                          </Show>
                          <div class="flex-1" />
                          <OpenFileButton onOpen={openerFor(file)} />
                          <ViewedBox viewed={allViewed()} onChange={(on) => setViewed(ids(), on)} />
                        </header>
                        <For each={s.hunks}>{(p) => hunk(p, { bar: s.hunks.length > 1 })}</For>
                      </section>
                    )
                  // A group of Claude's guide: a heading on the page, not a box, so the hunks are the only boxes.
                  return (
                    <section ref={(el) => sectionEls.set(s.id, el)} class="mt-6 scroll-mt-3">
                      {/* Stuck to the top while its group is in view, so you know which one you're in. */}
                      <header class="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-line bg-bg py-2">
                        <AttentionBadge attention={s.attention} />
                        <h2 class="min-w-0 text-base text-fg">{s.title}</h2>
                        <Show when={s.kind}>
                          <span class="text-xs text-fg-3">{s.kind}</span>
                        </Show>
                        <div class="flex-1" />
                        <Show when={s.attention === 'changed' && props.onSend}>
                          <Button class="flex h-7 items-center gap-1 text-xs" disabled={props.running} onClick={() => props.onSend!(UPDATE_GUIDE)}>
                            Update the guide
                          </Button>
                        </Show>
                        <Show when={s.hunks.length > 1}>
                          <span class="text-xs text-fg-3 tabular-nums">
                            {s.hunks.filter((p) => isViewed(p.hunk.id)).length}/{s.hunks.length}
                          </span>
                        </Show>
                        {/* Even with one hunk: the header stays stuck at the top, so it's in reach from anywhere in a long one. */}
                        <ViewedBox viewed={allViewed()} onChange={(on) => setViewed(ids(), on)} label={s.hunks.length > 1 ? 'All viewed' : 'Viewed'} />
                      </header>
                      {/* The explanation beside its hunks where there's room, each pinned (see pin); above them where there isn't. */}
                      <div class={`grid gap-4 pt-3 ${side() ? '@4xl:grid-cols-[minmax(16rem,26rem)_minmax(0,1fr)]' : ''}`}>
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
                          <For each={s.hunks}>{(p) => hunk(p)}</For>
                        </div>
                      </div>
                    </section>
                  )
                }}
              </For>
            </div>
          </div>

          {/* What goes back to Claude: only once there's something to send, or a comment on the whole is being started. */}
          <Show when={commenting()}>
          <div class="flex shrink-0 items-end gap-2 border-t border-line px-3 py-2">
            <textarea
              ref={generalBox}
              value={saved().general}
              onInput={(e) => {
                const general = e.currentTarget.value
                update((s) => ({ ...s, general }))
              }}
              // Left empty, with nothing else to send, it goes away again.
              onBlur={() => setWriting(false)}
              onKeyDown={(e) => e.key === 'Escape' && !saved().general.trim() && e.currentTarget.blur()}
              placeholder={comments().length ? `Anything to add to the ${plural(comments().length, 'comment')} on lines? Optional` : 'A comment on the changes as a whole'}
              rows={1}
              // Grows with what's typed, as the composer does.
              class={`${inputClass} h-auto max-h-[calc(8lh+0.75rem)] min-w-0 flex-1 resize-none py-1.5 [field-sizing:content]`}
            />
            <Button
              primary
              disabled={!props.onSend || (!saved().comments.length && !saved().general.trim())}
              onClick={send}
              title={props.guided ? 'Claude acts on them, then updates the guide' : 'To this chat, for Claude to act on'}
              class="shrink-0"
            >
              {saved().comments.length ? `Send ${plural(saved().comments.length, 'comment')}` : props.guided ? 'Send to Claude' : 'Send'}
            </Button>
          </div>
          </Show>
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

/** Folds or unfolds a file or hunk. */
function FoldButton(props: { open: boolean; onClick: () => void }) {
  return (
    <GhostButton size="sm" title={props.open ? 'Fold' : 'Unfold'} onClick={props.onClick}>
      {props.open ? <ChevronDown class="size-3.5" /> : <ChevronRight class="size-3.5" />}
    </GhostButton>
  )
}

/** Opens the whole file, at `line` if given. Nothing where files can't be opened. */
function OpenFileButton(props: { onOpen?: (line?: number) => void; line?: number }) {
  return (
    <Show when={props.onOpen}>
      {(open) => (
        <GhostButton size="sm" title={props.line ? `Open the whole file at line ${props.line}` : 'Open the whole file'} onClick={() => open()(props.line)}>
          <FileText class="size-3.5" />
        </GhostButton>
      )}
    </Show>
  )
}

function ViewedBox(props: { viewed: boolean; onChange: (on: boolean) => void; label?: string }) {
  return (
    <label class="flex shrink-0 cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-xs text-fg-3 hover:text-fg-2">
      <input type="checkbox" checked={props.viewed} onChange={(e) => props.onChange(e.currentTarget.checked)} class="accent-(--color-primary)" />
      {props.label ?? 'Viewed'}
    </label>
  )
}

const STATUS_LETTER = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R' } as const
const STATUS_TONE = { added: 'text-ok', modified: 'text-fg-3', deleted: 'text-danger', renamed: 'text-accent' } as const

function HunkView(props: {
  ref: (el: HTMLElement) => void
  /**
   * In its file's box, under the file's header, rather than a box of its own: `bar` splits it from the one before
   * with its @@ line, folding and a tick of its own; without, the file's header folds and ticks it.
   */
  bare?: { bar: boolean }
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
  /** Opens the whole file beside the chat, at the line given; absent where there's nowhere to. */
  onOpen?: (line?: number) => void
  onViewed: (on: boolean) => void
  /** Comment on what's selected: rows from..to, from `start` in the first to `end` in the last. */
  onSelect: (from: number, to: number, start?: number, end?: number) => void
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
  const startLine = () => startOf(props.rows)
  const [shown, setShown] = createSignal(false)
  const nothing = () => !props.rows.length
  const folded = () => f().generated && !shown()
  /** Open at some point: from then on its rows stay on the page, hidden while it's folded, so unfolding doesn't build them again. */
  const opened = createMemo((was: boolean) => was || props.open, false)
  // Highlighted once it's open and near the screen, so a long review only highlights what's looked at.
  const [near, setNear] = createSignal(false)
  let box!: HTMLDivElement
  onMount(() => {
    const seen = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && (setNear(true), seen.disconnect()), { rootMargin: '800px' })
    seen.observe(box)
    onCleanup(() => seen.disconnect())
  })
  const [html] = createResource(
    () => near() && opened() && !folded() && props.rows.length > 0 && { rows: props.rows, lang: languageOf(f().path) },
    async ({ rows, lang }) => ({ rows, lines: await highlightRows(rows, lang) }),
  )
  // What changed, drawn as shapes behind the text once the rows are on the page, and again whenever they move.
  const [body, setBody] = createSignal<HTMLDivElement>()
  let marks: SVGSVGElement | undefined
  const codeEls: HTMLElement[] = []
  let queued = 0
  const draw = () => {
    queued = 0
    // Not until it's near the screen: measuring a hunk lays it out, which is what skipping off-screen ones saves. Nor while
    // it's folded: its marks stay as they were, and its rows resizing as it unfolds draws them again.
    if (!near() || !props.open) return
    const el = body()
    if (!el || !marks || !el.isConnected) return
    const at = el.getBoundingClientRect()
    const half = parseFloat(getComputedStyle(el).lineHeight) / 2 || 10
    const boxes: Record<'add' | 'del', Box[]> = { add: [], del: [] }
    props.rows.forEach((r, i) => {
      if (r.kind === 'hunk' || r.kind === 'ctx' || !r.marks?.length || !codeEls[i]?.isConnected) return
      // Under what's selected the selection shows instead, rather than its colour mixing with theirs.
      const cut = [selectedIn(i), draftedIn(i)].filter((x): x is [number, number] => !!x)
      for (const m of r.marks.flatMap((m) => cut.reduce<[number, number][]>((left, c) => left.flatMap((x) => without(x, c)), [m]))) {
        for (const b of textBoxes(codeEls[i], m)) {
          if (!b.width) continue
          // As tall as the line, not the text, so marks on lines one under another meet.
          const mid = (b.top + b.bottom) / 2 - at.top
          // Exactly the text's width, so where a selection cuts a mark the two meet rather than overlap.
          boxes[r.kind].push({ l: b.left - at.left, r: b.right - at.left, t: mid - half, b: mid + half })
        }
      }
    })
    // What's selected, or what a comment's being written on, which is what was selected: drawn like the rest rather than by
    // the browser, character by character, leaving out the line numbers and signs a selection runs through on its way.
    const selected: Box[] = []
    const code = codeEls.find((c) => c?.isConnected)?.getBoundingClientRect()
    const add = (b: DOMRect) => {
      if (!b.width || !code || b.left < code.left - 1 || b.bottom < at.top || b.top > at.bottom) return
      const mid = (b.top + b.bottom) / 2 - at.top
      selected.push({ l: b.left - at.left, r: b.right - at.left, t: mid - half, b: mid + half })
    }
    const d = props.draft
    if (d) {
      const ch = parseFloat(getComputedStyle(el).fontSize) * 0.6
      for (let i = d.from; i <= d.to; i++) {
        const c = codeEls[i]
        const r = props.rows[i]
        if (!c?.isConnected || !r || r.kind === 'hunk') continue
        const from = i === d.from ? (d.start ?? 0) : 0
        const to = i === d.to ? (d.end ?? r.text.length) : r.text.length
        const got = to > from ? textBoxes(c, [from, to]) : []
        // A blank line in it as a character's width, placed by its row: an empty span measures as nothing at the baseline.
        if (!got.length && from === 0) {
          const row = c.closest('[data-row]')?.getBoundingClientRect()
          const left = c.getBoundingClientRect().left
          if (row) got.push(new DOMRect(left, row.top, ch, half * 2))
        }
        got.forEach(add)
      }
    }
    const range = selection()
    if (range) for (const b of range.getClientRects()) add(b)
    marks.innerHTML = [
      ...(
        [
          ['add', '--color-ok'],
          ['del', '--color-danger'],
        ] as const
      ).map(([kind, colour]) => `<path d="${blobs(boxes[kind], 4)}" style="fill: var(${colour}); opacity: 0.28" />`),
      selected.length ? `<path d="${blobs(selected, 4)}" style="fill: var(--color-selection); opacity: 0.3" />` : '',
    ].join('')
  }

  /** The page's text selection while some of it is in this hunk; where to offer commenting on it, once it's been made. */
  const [selection, setSelection] = createSignal<Range>()
  const [offer, setOffer] = createSignal<{ from: number; to: number; start: number; end: number; x: number; y: number }>()
  /** Where a point of a selection is in a row's code, as an offset into its text; its start or end if it's outside it. */
  const offsetIn = (row: number, node: Node, offset: number, side: 'start' | 'end') => {
    const c = codeEls[row]
    const text = props.rows[row]?.kind === 'hunk' ? '' : (props.rows[row] as Line).text
    if (!c || !c.contains(node)) return side === 'start' ? 0 : text.length
    const before = document.createRange()
    before.setStart(c, 0)
    before.setEnd(node, offset)
    return Math.min(before.toString().length, text.length)
  }
  /** What of row i's text the selection covers, from..to, if any of it. */
  const selectedIn = (i: number): [number, number] | undefined => {
    const rows = selectedRows()
    const range = selection()
    const r = props.rows[i]
    if (!rows || !range || i < rows[0] || i > rows[1] || r.kind === 'hunk') return
    const from = i === rows[0] ? offsetIn(i, range.startContainer, range.startOffset, 'start') : 0
    const to = i === rows[1] ? offsetIn(i, range.endContainer, range.endOffset, 'end') : r.text.length
    return [from, to]
  }
  /** What of row i's text the comment being written is on, from..to, if any of it. */
  const draftedIn = (i: number): [number, number] | undefined => {
    const d = props.draft
    const r = props.rows[i]
    if (!d || i < d.from || i > d.to || r.kind === 'hunk') return
    return [i === d.from ? (d.start ?? 0) : 0, i === d.to ? (d.end ?? r.text.length) : r.text.length]
  }
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
    // Not one with an end in this hunk but outside its lines, e.g. text picked out of an answer or a comment.
    const stray = (n: Node) => el?.contains(n) && !rowOf(n)
    const here = el && range && range.intersectsNode(el) && !stray(range.startContainer) && !stray(range.endContainer) ? range : undefined
    if (!here && !selection()) return
    setSelection(here?.cloneRange())
    if (!here) setOffer(undefined)
    redraw()
  }
  // Offered once the mouse lets go, for a selection that starts and ends in this hunk's lines.
  const onSelected = () => {
    const el = body()
    const sel = getSelection()
    // Read now, not from the signal: the selection may have been made this moment, before selectionchange has said.
    const range = sel && !sel.isCollapsed && sel.rangeCount ? sel.getRangeAt(0) : undefined
    const from = range && rowOf(range.startContainer)
    const to = range && rowOf(range.endContainer)
    if (!el || !range || !from || !to || !el.contains(from) || !el.contains(to)) return setOffer(undefined)
    const end = [...range.getClientRects()].filter((b) => b.width).at(-1)
    const at = el.getBoundingClientRect()
    const f = Number(from.dataset.row)
    const t = Number(to.dataset.row)
    if (end)
      setOffer({
        from: f,
        to: t,
        start: offsetIn(f, range.startContainer, range.startOffset, 'start'),
        end: offsetIn(t, range.endContainer, range.endOffset, 'end'),
        x: end.right - at.left,
        y: end.bottom - at.top,
      })
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
    props.onSelect(o.from, o.to, o.start, o.end)
  }
  const redraw = () => {
    if (!queued) queued = requestAnimationFrame(draw)
  }
  // Only this hunk's draft: picking lines elsewhere doesn't redraw every hunk.
  const draft = createMemo(() => props.draft)
  createEffect(on(draft, redraw, { defer: true }))
  createEffect(on(near, (n) => n && redraw(), { defer: true }))
  createEffect(() => {
    const el = body()
    if (!el) return
    const resized = new ResizeObserver(redraw)
    resized.observe(el)
    onCleanup(() => resized.disconnect())
  })

  /** Only for the rows it was made from: while new rows are highlighted, the last ones' lines would be out of step. */
  /**
   * Pressing on a line's numbers selects the line, and dragging up or down selects the lines between, scrolling the page near
   * its edges: an ordinary selection of whole lines, so it's commented on as any other is. Shift extends the selection to it.
   */
  const selectRows = (anchor: number, at: number) => {
    const a = codeEls[anchor]
    const b = codeEls[at]
    if (!a || !b) return
    if (anchor <= at) getSelection()?.setBaseAndExtent(a, 0, b, b.childNodes.length)
    else getSelection()?.setBaseAndExtent(a, a.childNodes.length, b, 0)
  }
  const selectFrom = (e: PointerEvent, at: number) => {
    if (e.button !== 0) return
    e.preventDefault()
    const sel = getSelection()
    const was = sel?.anchorNode && rowOf(sel.anchorNode)
    const anchor = e.shiftKey && was && body()?.contains(was) ? Number(was.dataset.row) : at
    let to = at
    selectRows(anchor, at)
    const page = body()?.closest('.overflow-y-auto')
    const move = (ev: PointerEvent) => {
      const row = (document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null)?.closest<HTMLElement>('[data-row]')
      if (row && body()?.contains(row) && Number(row.dataset.row) !== to) selectRows(anchor, (to = Number(row.dataset.row)))
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
      class={
        props.bare
          ? `scroll-mt-10 border-t border-line ${!props.bare.bar && !props.open ? 'hidden' : ''}`
          : `scroll-mt-14 overflow-hidden rounded-lg border ${props.viewed ? 'border-line/60' : 'border-line'}`
      }>
      <Show when={props.bare?.bar}>
        <div class="flex h-7 items-center gap-2 px-2 text-xs text-fg-3">
          <FoldButton open={props.open} onClick={props.onToggle} />
          <button onClick={props.onToggle} class="flex min-w-0 items-center gap-2 text-left font-mono">
            <Show when={startLine()}>{(n) => <span class="shrink-0 tabular-nums">line {n()}</span>}</Show>
            <Show when={context()}>
              <span class="min-w-0 truncate">{context()}</span>
            </Show>
          </button>
          <div class="flex-1" />
          <OpenFileButton onOpen={props.onOpen} line={startLine()} />
          <ViewedBox viewed={props.viewed} onChange={props.onViewed} />
        </div>
      </Show>
      <Show when={!props.bare}>
        <div class="flex items-center gap-2 bg-surface px-2 py-1 text-xs">
          <FoldButton open={props.open} onClick={props.onToggle} />
          <span class={`shrink-0 font-mono ${STATUS_TONE[f().status]}`}>{STATUS_LETTER[f().status]}</span>
          <button onClick={props.onToggle} class="flex min-w-0 text-left text-fg">
            <PathLabel path={f().path} oldPath={f().oldPath} suffix={<Show when={startLine()}>:{startLine()}</Show>} />
          </button>
          <Show when={context()}>
            <span class="hidden min-w-0 truncate font-mono text-fg-3 @2xl:block">{context()}</span>
          </Show>
          <div class="flex-1" />
          <OpenFileButton onOpen={props.onOpen} line={startLine()} />
          <ViewedBox viewed={props.viewed} onChange={props.onViewed} />
        </div>
      </Show>

      <Show when={opened()}>
        <div classList={{ hidden: !props.open }}>
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
            <div ref={setBody} class="relative isolate font-mono text-xs leading-5">
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
                  const editing = () => props.draft && props.draft.to === i()
                  return (
                    <>
                      <CodeRow
                        data-row={i()}
                        kind={r.kind}
                        numbers={[r.old, r.new]}
                        sign
                        gutter={{
                          onPointerDown: (e) => selectFrom(e, i()),
                          title: 'Select this line: drag to select more, shift-click to extend',
                          class: 'cursor-pointer',
                        }}
                      >
                        {/* The browser's own selection colour is hidden on the code: it's drawn with the marks, as a shape. */}
                        <span class="min-w-0 flex-1 whitespace-pre-wrap break-all pr-3 text-fg selection:bg-transparent">
                          <Code line={r} html={lineHtml(i())} ref={(el) => (codeEls[i()] = el)} onDrawn={redraw} />
                        </span>
                      </CodeRow>
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
        </div>
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
