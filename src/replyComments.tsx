import { For, Show, createContext, createEffect, createMemo, createSignal, onCleanup, onMount, useContext } from 'solid-js'
import { Portal } from 'solid-js/web'
import type { ReplyComment, WireMessage } from '../shared/protocol.ts'
import { blockquote, plural } from './format.ts'
import { CommentBox, DraftBox, blobs, type Box } from './components/Comments.tsx'
import { Markdown } from './components/Markdown.tsx'

/*
 * Comments on parts of Claude's replies, or of a plan waiting for an answer, kept to send together rather than answered
 * one by one. Each is under the paragraph or list item it's on, with what it's on drawn behind the text, as comments on
 * a diff's lines are. A reply's go out with the next message, kept with the chat's draft on the server; a plan's go
 * with its answer, kept in this tab as the rest of what's said with a plan is (see Plan.tsx).
 */

const PLAN = 'plan:'
export const planAnchor = (requestId: string) => `${PLAN}${requestId}`
export const isPlanComment = (c: ReplyComment) => c.on.startsWith(PLAN)

/** Comments on plans, from every chat: a plan's request id is its own. */
const [planComments, setPlanComments] = createSignal<ReplyComment[]>([])

/** A plan's comments, taken to go with its answer. */
export function takePlanComments(requestId: string): ReplyComment[] {
  const on = planAnchor(requestId)
  const taken = planComments().filter((c) => c.on === on)
  if (taken.length) setPlanComments((all) => all.filter((c) => c.on !== on))
  return taken
}
export const planCommentCount = (requestId: string) => planComments().filter((c) => c.on === planAnchor(requestId)).length

/** Where a comment is being written: on what was selected of a reply or plan, or editing one already there. */
export type CommentDraft = Omit<ReplyComment, 'id' | 'text'> & {
  /** Editing this comment, rather than adding one. */
  id?: string
}

export interface ReplyCommentsApi {
  /** Comments on this reply or plan. */
  on: (on: string) => ReplyComment[]
  save: (c: ReplyComment) => void
  /** Keeps what's typed in the comment being written, if anything, and closes it. */
  commit: (d: CommentDraft) => void
  remove: (c: ReplyComment) => void
  draft: () => CommentDraft | undefined
  setDraft: (d: CommentDraft | undefined) => void
  /** What's typed in the comment being written. */
  draftText: () => string
  setDraftText: (t: string) => void
}

/** Given, Claude's replies and plans can be commented on. */
export const ReplyComments = createContext<ReplyCommentsApi>()
export const useReplyComments = () => useContext(ReplyComments)

/** Comments kept with a chat's draft, through its `attach`, and on plans. */
export function createReplyComments(draft: {
  comments: () => ReplyComment[]
  attach: (change: (comments: ReplyComment[]) => ReplyComment[]) => void
}): ReplyCommentsApi {
  const [current, setCurrent] = createSignal<CommentDraft>()
  const [draftText, setDraftText] = createSignal('')
  const change = (c: ReplyComment, f: (all: ReplyComment[]) => ReplyComment[]) => (isPlanComment(c) ? setPlanComments(f) : draft.attach(f))
  const save = (c: ReplyComment) => change(c, (all) => (all.some((x) => x.id === c.id) ? all.map((x) => (x.id === c.id ? c : x)) : [...all, c]))
  const setDraft = (d: CommentDraft | undefined) => {
    setCurrent(d)
    setDraftText(d?.id ? (draft.comments().find((c) => c.id === d.id) ?? planComments().find((c) => c.id === d.id))?.text ?? '' : '')
  }
  return {
    on: (on) => (on.startsWith(PLAN) ? planComments() : draft.comments()).filter((c) => c.on === on),
    save,
    commit: (d) => {
      const text = draftText().trim()
      if (text) save({ ...d, id: d.id ?? crypto.randomUUID(), text })
      setDraft(undefined)
    },
    remove: (c) => change(c, (all) => all.filter((x) => x.id !== c.id)),
    draft: current,
    setDraft,
    draftText,
    setDraftText,
  }
}

// ── Messages to Claude ──

const QUOTE_MAX = 600

/** Comments in the order of what they're on: reply by reply, and down each reply. */
export function inOrder(comments: ReplyComment[], messages: WireMessage[]): ReplyComment[] {
  const pos = new Map(messages.map((m, i) => [m.uuid, i]))
  const where = (c: ReplyComment) => {
    const at = c.on.lastIndexOf(':')
    return [pos.get(c.on.slice(0, at)) ?? Infinity, Number(c.on.slice(at + 1)) || 0, c.start ?? 0]
  }
  return comments
    .map((c, i) => ({ c, i, w: where(c) }))
    .sort((a, b) => a.w[0] - b.w[0] || a.w[1] - b.w[1] || a.w[2] - b.w[2] || a.i - b.i)
    .map((x) => x.c)
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max).trimEnd()}…` : text)

/** The message comments go back to Claude in: `lead` says what they're on and what to do, then each under what it's on, then anything else to say. */
export function commentsMessage(comments: ReplyComment[], note: string, lead: string): string {
  return [lead.replace('%n', plural(comments.length, 'comment')), ...comments.map((c) => `${blockquote(c.quote, QUOTE_MAX)}\n\n${c.text.trim()}`), note.trim()]
    .filter(Boolean)
    .join('\n\n')
}

export const REPLIES_LEAD = 'I left %n on your replies. Answer or act on each, and say if you disagree with any.'

// ── Where in a reply ──

/** Holds the comments shown in a reply: not part of its text, for working out where things are in it. */
const HOST = 'reply-comments'
/** Blocks a comment goes under: the innermost the end of what it's on is in. */
const BLOCK = 'p, li, .code-block, table, blockquote, h1, h2, h3, h4, h5, h6'

/** A reply's text, node by node, leaving out code blocks' headers and the comments shown in it. */
function textNodes(root: HTMLElement): Text[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest(`.code-head, .${HOST}`) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  })
  const out: Text[] = []
  while (walker.nextNode()) out.push(walker.currentNode as Text)
  return out
}

/** Where a point is in a reply's text, as an offset into it. */
function offsetOf(root: HTMLElement, node: Node, offset: number): number {
  const point = document.createRange()
  point.setStart(node, offset)
  let n = 0
  for (const t of textNodes(root)) {
    if (t === node) return n + offset
    if (point.comparePoint(t, t.length) !== -1) return n
    n += t.length
  }
  return n
}

/** What of a reply's text a selection is, from..to. */
export function offsetsIn(reply: HTMLElement, range: Range): { start: number; end: number } | undefined {
  const root = reply.querySelector<HTMLElement>('.md')
  if (!root) return
  const start = offsetOf(root, range.startContainer, range.startOffset)
  const end = offsetOf(root, range.endContainer, range.endOffset)
  return end > start ? { start, end } : undefined
}

/** Characters from..to of a reply's text as a range of its page, or the text node `to` is in when from = to. */
function rangeOf(root: HTMLElement, from: number, to: number): { range: Range; last?: Text } | undefined {
  const range = document.createRange()
  let n = 0
  let started = false
  for (const t of textNodes(root)) {
    if (!started && from < n + t.length) {
      range.setStart(t, from - n)
      started = true
    }
    if (started && to <= n + t.length) {
      range.setEnd(t, to - n)
      return { range, last: t }
    }
    n += t.length
  }
}

// ── On the page ──

/**
 * One of Claude's replies. With comments to be made, each is shown under the paragraph or list item it's on, with what
 * it's on drawn behind the text; text selected in it is offered to comment on (see QuoteSelection).
 */
export function ReplyBody(props: { id: string; text: string }) {
  const api = useReplyComments()
  if (!api) return <Markdown text={props.text} />
  let el!: HTMLDivElement
  let marks!: SVGSVGElement
  /** Bumped once the reply's drawn, and when its text changes, to place comments in it again. */
  const [drawn, setDrawn] = createSignal(0)
  const root = () => el.querySelector<HTMLElement>('.md') ?? el
  onMount(() => {
    const bump = () => setDrawn((n) => n + 1)
    // Markdown draws the reply when it's ready, which can be after this is mounted, and again if its text changes.
    const changed = new MutationObserver(bump)
    changed.observe(root(), { childList: true })
    requestAnimationFrame(bump)
    onCleanup(() => changed.disconnect())
  })

  const comments = () => api.on(props.id)
  const draft = () => {
    const d = api.draft()
    return d?.on === props.id ? d : undefined
  }

  /** A box for comments under each block that has any, kept for as long as the block is. */
  const hosts = new Map<Element, HTMLDivElement>()
  const blockAt = (end: number) => {
    drawn()
    const r = root()
    const got = rangeOf(r, Math.max(0, end - 1), end)
    const block = got?.last?.parentElement?.closest(BLOCK)
    return block && r.contains(block) ? block : r
  }
  const hostFor = (block: Element) => {
    let host = hosts.get(block)
    if (!host?.isConnected) {
      host = document.createElement('div')
      host.className = `${HOST} not-prose`
      // In a list item, inside it, so it's indented with it; anywhere else, after the block.
      if (block === root() || block.tagName === 'LI') block.append(host)
      else block.after(host)
      hosts.set(block, host)
    }
    return host
  }
  /** Where each comment, and the one being written, goes. */
  const placed = createMemo(() => {
    const at = new Map<HTMLDivElement, { comments: ReplyComment[]; draft: boolean }>()
    if (!drawn()) return at
    const put = (end: number | undefined, f: (x: { comments: ReplyComment[]; draft: boolean }) => void) => {
      const host = hostFor(blockAt(end ?? Infinity))
      if (!at.has(host)) at.set(host, { comments: [], draft: false })
      f(at.get(host)!)
    }
    for (const c of [...comments()].sort((a, b) => (a.start ?? 0) - (b.start ?? 0))) put(c.end, (x) => x.comments.push(c))
    const d = draft()
    if (d && !d.id) put(d.end, (x) => (x.draft = true))
    return at
  })

  // What each comment is on, drawn as a shape behind the text; the one being written in the selection's colour.
  let frame = 0
  const draw = () => {
    frame = 0
    if (!el?.isConnected) return
    const r = root()
    const at = el.getBoundingClientRect()
    const boxesOf = (from?: number, to?: number) => {
      const got = from !== undefined && to !== undefined && to > from ? rangeOf(r, from, to) : undefined
      if (!got) return []
      const out: Box[] = []
      for (const t of textNodes(r)) {
        if (!got.range.intersectsNode(t)) continue
        const part = document.createRange()
        part.selectNodeContents(t)
        if (t === got.range.startContainer) part.setStart(t, got.range.startOffset)
        if (t === got.range.endContainer) part.setEnd(t, got.range.endOffset)
        // As tall as the line, not the text, so a comment's lines meet.
        const half = (parseFloat(getComputedStyle(t.parentElement!).lineHeight) || 20) / 2
        for (const b of part.getClientRects()) {
          if (!b.width) continue
          const mid = (b.top + b.bottom) / 2 - at.top
          out.push({ l: b.left - at.left, r: b.right - at.left, t: mid - half, b: mid + half })
        }
      }
      return out
    }
    const d = draft()
    const editing = d?.id
    const kept = comments().filter((c) => c.id !== editing).flatMap((c) => boxesOf(c.start, c.end))
    const writing = d ? boxesOf(d.start, d.end) : []
    marks.innerHTML = [
      kept.length ? `<path d="${blobs(kept, 4)}" style="fill: var(--color-accent); opacity: 0.18" />` : '',
      writing.length ? `<path d="${blobs(writing, 4)}" style="fill: var(--color-selection); opacity: 0.3" />` : '',
    ].join('')
  }
  const redraw = () => (frame ||= requestAnimationFrame(draw))
  createEffect(() => {
    placed()
    draft()
    redraw()
  })
  onMount(() => {
    // Comments opening and closing in it, code being highlighted, and the pane being resized all move its text.
    const seen = new ResizeObserver(() => (comments().length || draft()) && redraw())
    seen.observe(el)
    onCleanup(() => {
      seen.disconnect()
      cancelAnimationFrame(frame)
    })
  })
  onCleanup(() => hosts.forEach((h) => h.remove()))

  const close = () => api.setDraft(undefined)
  const draftBox = (d: CommentDraft) => (
    <DraftBox
      text={api.draftText()}
      editing={!!d.id}
      placeholder="On this…"
      sentWith="with your next message"
      onText={api.setDraftText}
      onComment={() => api.commit(d)}
      onCancel={close}
    />
  )

  return (
    <div ref={el} data-reply={props.id} class="relative isolate">
      <svg ref={marks} class="pointer-events-none absolute inset-0 -z-10 size-full overflow-visible" aria-hidden="true" />
      <Markdown text={props.text} />
      <For each={[...placed().keys()]}>
        {(host) => (
          <Portal mount={host}>
            <For each={placed().get(host)?.comments}>
              {(c) => (
                <Show when={draft()?.id === c.id ? draft() : undefined} fallback={<CommentBox text={c.text} onEdit={() => api.setDraft({ ...c })} onRemove={() => api.remove(c)} />}>
                  {(d) => draftBox(d())}
                </Show>
              )}
            </For>
            <Show when={placed().get(host)?.draft && draft()}>{(d) => draftBox(d())}</Show>
          </Portal>
        )}
      </For>
    </div>
  )
}

/** A plan's comments, under it, each with what it's on: the plan is being edited, so they can't go in it. */
export function PlanComments(props: { on: string }) {
  const api = useReplyComments()
  return (
    <Show when={api}>
      {(api) => {
        const writing = () => (api().draft()?.on === props.on ? api().draft() : undefined)
        const close = () => api().setDraft(undefined)
        const label = (quote: string) => `On “${clip(quote.replace(/\s+/g, ' '), 80)}”`
        const draftBox = (d: CommentDraft) => (
          <>
            <p class="mt-2 truncate text-xs text-fg-3">{label(d.quote)}</p>
            <DraftBox
              text={api().draftText()}
              editing={!!d.id}
              placeholder="On this…"
              sentWith="with your answer to the plan"
              onText={api().setDraftText}
              onComment={() => api().commit(d)}
              onCancel={close}
            />
          </>
        )
        return (
          <>
            <For each={api().on(props.on)}>
              {(c) => (
                <Show when={writing()?.id === c.id ? writing() : undefined} fallback={<CommentBox label={label(c.quote)} text={c.text} onEdit={() => api().setDraft({ ...c })} onRemove={() => api().remove(c)} />}>
                  {(d) => draftBox(d())}
                </Show>
              )}
            </For>
            <Show when={writing() && !writing()!.id ? writing() : undefined}>{(d) => draftBox(d())}</Show>
          </>
        )
      }}
    </Show>
  )
}
