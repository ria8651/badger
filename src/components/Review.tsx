import { For, Show, createEffect, createMemo, createResource, createSignal, on, onCleanup, onMount, untrack } from 'solid-js'
import { Check, ChevronDown, ChevronRight, MessageSquarePlus, RotateCw, Sparkles, Trash2 } from '../icons'
import type { ReviewAttention, ReviewDiff, ReviewFile, ReviewGroup, ReviewGuide, ReviewHunk } from '../../shared/protocol.ts'
import { api } from '../api.ts'
import { plural } from '../format.ts'
import { highlight, languageOf } from '../highlight.ts'
import { itemsFor, type Block, type Index } from '../transcript/model.ts'
import { Markdown } from './Markdown.tsx'
import { Button, DiffCount, GhostButton, inputClass } from './ui.tsx'

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

type Line = { kind: 'ctx' | 'add' | 'del'; old?: number; new?: number; text: string; /** The part that changed, against its pair. */ mark?: [number, number] }
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
  markPairs(rows)
  return rows
}

/** A run of removed lines then as many added: each pair's changed middle, when it's a small edit rather than a new line. */
function markPairs(rows: Row[]) {
  for (let i = 0; i < rows.length; ) {
    let d = i
    while (d < rows.length && rows[d].kind === 'del') d++
    let a = d
    while (a < rows.length && rows[a].kind === 'add') a++
    const dels = d - i
    if (dels && a - d === dels) {
      for (let k = 0; k < dels; k++) {
        const x = rows[i + k] as Line
        const y = rows[d + k] as Line
        let p = 0
        while (p < x.text.length && p < y.text.length && x.text[p] === y.text[p]) p++
        let s = 0
        while (s < x.text.length - p && s < y.text.length - p && x.text[x.text.length - 1 - s] === y.text[y.text.length - 1 - s]) s++
        const same = p + s
        if (same && same > Math.max(x.text.length, y.text.length) * 0.3) {
          x.mark = [p, x.text.length - s]
          y.mark = [p, y.text.length - s]
        }
      }
    }
    i = Math.max(a, i + 1)
  }
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

/** Claude's replies to each question, by its id: what it said after the question went in, until the next message. */
function answersOf(index: Index, questions: Question[]): Map<string, string> {
  const ids = new Map(questions.map((q) => [q.message.trim(), q.id]))
  const out = new Map<string, string>()
  let current: string | undefined
  for (const m of index.groups.get('') ?? []) {
    for (const item of itemsFor(m)) {
      if (item.kind === 'user') {
        current = ids.get(item.text.trim())
        if (current) out.set(current, '')
      } else if (current && item.kind === 'text') out.set(current, [out.get(current), item.text].filter(Boolean).join('\n\n'))
    }
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

/** Where a new comment or question is going: rows from..to of one hunk. */
interface Draft {
  hunk: string
  from: number
  to: number
  /** Editing this comment, rather than adding one. */
  id?: string
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
  }
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

  return (
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
          <div class="mx-auto max-w-[100rem] px-4 pb-10 @3xl:px-6">
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
                    <Sparkles class={`size-3.5 shrink-0 text-accent ${props.running ? 'animate-pulse' : ''}`} />
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
                          <Sparkles class="size-3" /> Update the guide
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
                                ref={(el) => hunkEls.set(id, el)}
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
          rows={saved().general ? 3 : 1}
          placeholder="Overall comment (optional)"
          class={`${inputClass} h-auto resize-none py-1.5`}
        />
        <div class="flex flex-wrap items-center gap-2">
          <Button primary disabled={!props.onSend || (!saved().comments.length && !saved().general.trim())} onClick={send}>
            {saved().comments.length ? `Send ${plural(saved().comments.length, 'comment')}` : 'Send to Claude'}
          </Button>
          <span class="text-xs text-fg-3">Click a line’s + to comment or ask; shift-click another to cover the lines between. Claude acts on comments, then updates the guide.</span>
        </div>
      </div>
    </div>
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
  answers: Map<string, string>
  running: boolean
  draft?: Draft
  draftText: string
  canAsk: boolean
  onToggle: () => void
  onViewed: (on: boolean) => void
  onLine: (at: number, extend: boolean) => void
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
  /** Only for the rows it was made from: while new rows are highlighted, the last ones' lines would be out of step. */
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
          <div class="font-mono text-xs leading-5">
            <For each={props.rows}>
              {(r, i) => {
                if (r.kind === 'hunk') return null
                const anchor = anchorOf(r)
                const inDraft = () => !!props.draft && i() >= props.draft.from && i() <= props.draft.to
                const comments = () => props.comments.filter((c) => c.to === anchor)
                const questions = () => props.questions.filter((q) => q.to === anchor)
                const editing = () => props.draft && props.draft.to === i()
                return (
                  <>
                    <div
                      class={`group relative flex ${r.kind === 'add' ? 'bg-ok/10' : r.kind === 'del' ? 'bg-danger/10' : ''} ${inDraft() ? 'outline outline-1 -outline-offset-1 outline-accent/60' : ''}`}
                    >
                      <span class="w-10 shrink-0 select-none pr-1.5 text-right text-fg-3/70 tabular-nums">{r.old ?? ''}</span>
                      <span class="w-10 shrink-0 select-none pr-1.5 text-right text-fg-3/70 tabular-nums">{r.new ?? ''}</span>
                      <button
                        onClick={(e) => props.onLine(i(), e.shiftKey)}
                        title="Comment on or ask about this line (shift-click to cover from the last one)"
                        class="absolute left-0.5 top-0.5 grid size-4 place-items-center rounded bg-primary text-on-primary opacity-0 group-hover:opacity-100 pointer-coarse:opacity-40"
                      >
                        <MessageSquarePlus class="size-2.5" />
                      </button>
                      <span class={`w-4 shrink-0 select-none text-center ${r.kind === 'add' ? 'text-ok' : r.kind === 'del' ? 'text-danger' : 'text-fg-3'}`}>{SIGN[r.kind]}</span>
                      <span class="min-w-0 flex-1 whitespace-pre-wrap break-all pr-3 text-fg">
                        <Code line={r} html={lineHtml(i())} />
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
                      {(q) => <QuestionBox question={q} answer={props.answers.get(q.id)} running={props.running} onRemove={() => props.onRemoveQuestion(q.id)} />}
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

/** Wraps characters from..to of an element's text in spans of this class, one per token they're in, rounded at the ends as one. */
function markText(el: HTMLElement, [from, to]: [number, number], cls: string) {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  const texts: Text[] = []
  while (walker.nextNode()) texts.push(walker.currentNode as Text)
  let at = 0
  const spans: HTMLSpanElement[] = []
  for (const t of texts) {
    const start = Math.max(from - at, 0)
    const end = Math.min(to - at, t.length)
    at += t.length
    if (start >= end) continue
    const part = t.splitText(start)
    part.splitText(end - start)
    const span = document.createElement('span')
    span.className = cls
    part.replaceWith(span)
    span.append(part)
    spans.push(span)
  }
  spans[0]?.classList.add('rounded-l-sm')
  spans.at(-1)?.classList.add('rounded-r-sm')
}

/** A line, highlighted once that's done, with the part that changed against its pair picked out. */
function Code(props: { line: Line; html?: string }) {
  let el!: HTMLSpanElement
  const tone = () => `${props.line.kind === 'add' ? 'bg-ok/25' : 'bg-danger/25'}`
  // Filled by hand rather than by Solid, since highlighting replaces what's inside.
  createEffect(() => {
    if (props.html !== undefined) el.innerHTML = props.html
    else el.textContent = props.line.text
    if (props.line.mark) markText(el, props.line.mark, tone())
    if (!el.textContent) el.textContent = ' '
  })
  return <span ref={el} />
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
        rows={3}
        placeholder={props.lines > 1 ? `On these ${props.lines} lines…` : 'On this line…'}
        class="w-full resize-y bg-transparent text-ui outline-none placeholder:text-fg-3"
      />
      <div class="mt-1 flex flex-wrap items-center gap-2">
        <Button primary onClick={props.onComment} class="h-7 text-xs" title="Kept with your other comments, to send together for Claude to act on">
          {props.editing ? 'Save' : 'Add comment'}
        </Button>
        <Show when={!props.editing}>
          <Button onClick={props.onAsk} disabled={!props.canAsk} class="flex h-7 items-center gap-1 text-xs" title="Sent now; Claude's answer shows here">
            <Sparkles class="size-3" /> Ask Claude
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

function QuestionBox(props: { question: Question; answer?: string; running: boolean; onRemove: () => void }) {
  return (
    <div class={`${boxClass} group/q border-accent/30 bg-accent/5`}>
      <div class="mb-0.5 flex items-center gap-2 text-xs text-fg-3">
        <span>You asked</span>
        <div class="flex-1" />
        <button onClick={props.onRemove} title="Remove from the diff (it stays in the conversation)" class="opacity-0 hover:text-fg-2 group-hover/q:opacity-100">
          <Trash2 class="size-3" />
        </button>
      </div>
      <p class="whitespace-pre-wrap text-fg">{props.question.text}</p>
      <div class="mt-2 border-t border-accent/20 pt-2 text-fg-2">
        <Show
          when={props.answer}
          fallback={
            <span class="flex items-center gap-1.5 text-xs text-fg-3">
              <Sparkles class={`size-3 ${props.running ? 'animate-pulse' : ''}`} />
              {props.answer === undefined ? 'Waiting to go in…' : props.running ? 'Claude is answering…' : 'No answer.'}
            </span>
          }
        >
          {(a) => <Markdown text={a()} />}
        </Show>
      </div>
    </div>
  )
}
