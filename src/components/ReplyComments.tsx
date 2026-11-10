import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount, type JSX } from 'solid-js'
import { Portal } from 'solid-js/web'
import type { CommentAnchor, DraftComment } from '../../shared/protocol.ts'
import { planAnchor, useComments, type Asked, type CommentDraft } from '../comments.ts'
import { sessionById } from '../stores/sessions.ts'
import { AskedBox, CommentBox, DraftBox, blobs, type Box } from './Comments.tsx'
import { Markdown } from './Markdown.tsx'
import { QuoteSelection } from './QuoteSelection.tsx'

/*
 * Comments on Claude's replies and plans (see src/comments.ts). In a reply, each is under the paragraph or list item
 * it's on, with what it's on drawn behind the text, as comments on lines of the changes are. A plan can be edited, so
 * its comments are listed under it, each with what it's on.
 */

/** Holds the comments shown in a reply: not part of its text, for working out where things are in it. */
const HOST = 'comment-host'
/** Not the reply's text either: code blocks' headers, and diagrams, which are drawn after it's shown. */
const NOT_TEXT = `.code-head, .diagram, .${HOST}`
/** Blocks a comment goes under: the innermost one the end of what it's on is in. */
const BLOCK = 'p, li, .code-block, table, blockquote, h1, h2, h3, h4, h5, h6'

/**
 * A reply's text, node by node, and how much of each counts. A code block's own text ends in a line break until it's
 * highlighted, which then drops it, so that's never counted: where things are mustn't move as it is.
 */
function textNodes(root: HTMLElement): { t: Text; length: number }[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest(NOT_TEXT) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  })
  const out: { t: Text; length: number }[] = []
  while (walker.nextNode()) out.push({ t: walker.currentNode as Text, length: (walker.currentNode as Text).length })
  for (let i = 0; i < out.length; i++) {
    const { t } = out[i]
    const code = t.parentElement?.closest('pre code')
    const last = out[i + 1]?.t.parentElement?.closest('pre code') !== code
    if (code && last && t.data.endsWith('\n')) out[i].length--
  }
  return out
}

/** Where a point is in a reply's text, as an offset into it. */
function offsetOf(root: HTMLElement, node: Node, offset: number): number {
  const point = document.createRange()
  point.setStart(node, offset)
  let n = 0
  for (const { t, length } of textNodes(root)) {
    if (t === node) return n + Math.min(offset, length)
    if (point.comparePoint(t, t.length) !== -1) return n
    n += length
  }
  return n
}

/** Characters from..to of a reply's text as a range on the page, and the text node it ends in. */
function rangeOf(root: HTMLElement, from: number, to: number): { range: Range; last: Text } | undefined {
  const range = document.createRange()
  let n = 0
  let started = false
  for (const { t, length } of textNodes(root)) {
    if (!started && from < n + length) {
      range.setStart(t, from - n)
      started = true
    }
    if (started && to <= n + length) {
      range.setEnd(t, to - n)
      return { range, last: t }
    }
    n += length
  }
}

/** What's selected in something marked `data-comments-on`, as what a comment on it is on. */
export function anchorOf(el: HTMLElement, range: Range): CommentAnchor | undefined {
  const on = el.dataset.commentsOn
  if (!on) return
  if (on.startsWith('plan:')) return { kind: 'plan', request: on.slice(5) }
  const root = el.querySelector<HTMLElement>('.md')
  if (!root) return { kind: 'reply', reply: on }
  const start = offsetOf(root, range.startContainer, range.startOffset)
  const end = offsetOf(root, range.endContainer, range.endOffset)
  return end > start ? { kind: 'reply', reply: on, start, end } : { kind: 'reply', reply: on }
}

const onReply = (c: { on: CommentAnchor }, id: string | undefined): c is { on: Extract<CommentAnchor, { kind: 'reply' }> } & typeof c =>
  !!id && c.on.kind === 'reply' && c.on.reply === id

/**
 * One of Claude's replies. Once it's done, which gives it an id, it can be commented on: each comment is shown under
 * the block it's on, with what it's on drawn behind the text.
 */
export function ReplyBody(props: { id?: string; text: string; /** Its shell blocks can be run once it's done. */ done: boolean }) {
  const api = useComments()
  let el!: HTMLDivElement
  let marks!: SVGSVGElement
  const root = () => el.querySelector<HTMLElement>('.md') ?? el
  /** Bumped when the reply's blocks change, to place comments in it again. */
  const [drawn, setDrawn] = createSignal(0)
  onMount(() => {
    const bump = () => setDrawn((n) => n + 1)
    // Its blocks drawn again, or code in it highlighted; not the hosts this puts in it, nor the comments in those.
    const ours = (n: Node) => (n instanceof Element ? n : n.parentElement)?.closest(`.${HOST}`)
    const changed = new MutationObserver((records) => {
      if (records.some((r) => !ours(r.target) && [...r.addedNodes, ...r.removedNodes].some((n) => !ours(n)))) bump()
    })
    changed.observe(root(), { childList: true, subtree: true })
    bump()
    onCleanup(() => changed.disconnect())
  })

  /** Its comments, and questions asked about it, which show the same way. */
  const comments = createMemo(() => ([...(api?.all() ?? []), ...(api?.asked() ?? [])] as DraftComment[]).filter((c) => onReply(c, props.id)))
  const draft = () => {
    const d = api?.draft()
    return d && onReply(d, props.id) ? d : undefined
  }

  /** A box under each block with comments, kept for as long as the block is. */
  let hosts = new Map<Element, HTMLDivElement>()
  const blockAt = (r: HTMLElement, end: number | undefined) => {
    const got = end ? rangeOf(r, end - 1, end) : undefined
    const block = got?.last.parentElement?.closest(BLOCK)
    return block && r.contains(block) ? block : r
  }
  /** Where each comment, and the one being written, goes. */
  const placed = createMemo(() => {
    const at = new Map<HTMLDivElement, { comments: DraftComment[]; draft: boolean }>()
    const was = hosts
    hosts = new Map()
    if (!drawn() || (!comments().length && !draft())) {
      was.forEach((h) => h.remove())
      return at
    }
    const r = root()
    const put = (end: number | undefined) => {
      const block = blockAt(r, end)
      let host = hosts.get(block) ?? was.get(block)
      if (!host?.isConnected) {
        host = document.createElement('div')
        host.className = `${HOST} not-prose`
        // In a list item, inside it, so it's indented with it; anywhere else, after the block.
        if (block === r || block.tagName === 'LI') block.append(host)
        else block.after(host)
      }
      hosts.set(block, host)
      if (!at.has(host)) at.set(host, { comments: [], draft: false })
      return at.get(host)!
    }
    for (const c of [...comments()].sort((a, b) => (a.on.start ?? 0) - (b.on.start ?? 0))) put(c.on.end).comments.push(c)
    const d = draft()
    if (d && !d.id) put(d.on.end).draft = true
    for (const [block, host] of was) if (hosts.get(block) !== host) host.remove()
    return at
  })
  onCleanup(() => hosts.forEach((h) => h.remove()))

  // What each comment is on, drawn as a shape behind the text; the one being written in the selection's colour.
  let frame = 0
  const draw = () => {
    frame = 0
    if (!el?.isConnected) return
    const r = root()
    const at = el.getBoundingClientRect()
    const boxesOf = (from?: number, to?: number): Box[] => {
      const got = from !== undefined && to !== undefined && to > from ? rangeOf(r, from, to) : undefined
      if (!got) return []
      const out: Box[] = []
      for (const { t } of textNodes(r)) {
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
          const box = { l: b.left - at.left, r: b.right - at.left, t: mid - half, b: mid + half }
          // Across the little gap around inline code on the same line, as one.
          const last = out.at(-1)
          if (last && Math.abs(last.t - box.t) < 1 && box.l >= last.r && box.l - last.r < 8) last.r = box.r
          else out.push(box)
        }
      }
      return out
    }
    const d = draft()
    const kept = comments()
      .filter((c) => c.id !== d?.id)
      .flatMap((c) => boxesOf(c.on.start, c.on.end))
    const writing = d ? boxesOf(d.on.start, d.on.end) : []
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

  const draftBox = (d: CommentDraft) => (
    <DraftBox
      text={api!.draftText()}
      editing={!!d.id}
      placeholder="On this…"
      onText={api!.setDraftText}
      onComment={api!.commit}
      onCancel={() => api!.setDraft(undefined)}
      onAsk={d.id ? undefined : () => api!.ask(d, api!.draftText())}
      canAsk={api!.canAsk()}
    />
  )
  return (
    <div ref={el} data-comments-on={props.id} class="relative isolate">
      <svg ref={marks} class="pointer-events-none absolute inset-0 -z-10 size-full overflow-visible" aria-hidden="true" />
      <Markdown text={props.text} runnable={props.done} />
      <For each={[...placed().keys()]}>
        {(host) => (
          <Portal mount={host}>
            <For each={placed().get(host)?.comments}>
              {(c) =>
                'chat' in c ? (
                  <AskedItem asked={c as Asked} />
                ) : (
                  <Show when={draft()?.id === c.id ? draft() : undefined} fallback={<CommentBox text={c.text} onEdit={() => api!.setDraft({ ...c })} onRemove={() => api!.remove(c.id)} />}>
                    {(d) => draftBox(d())}
                  </Show>
                )
              }
            </For>
            <Show when={placed().get(host)?.draft && draft()}>{(d) => draftBox(d())}</Show>
          </Portal>
        )}
      </For>
    </div>
  )
}

/** A question asked about something, where it was asked, with its side chat to open beside the chat. */
export function AskedItem(props: { asked: Asked; label?: string; class?: string }) {
  const api = useComments()!
  return (
    <AskedBox
      label={props.label}
      text={props.asked.text}
      running={!!sessionById(props.asked.chat)?.running}
      onOpen={() => api.open(props.asked)}
      onRemove={() => api.forget(props.asked.id)}
      class={props.class}
    />
  )
}

/**
 * A plan waiting for an answer, marked so text selected in it can be commented on, and its comments under it: the
 * plan's being edited, so they can't go in it, nor can anything else, which would count as an edit.
 */
export function CommentablePlan(props: { requestId: string; class?: string; children: JSX.Element }) {
  const api = useComments()
  const on = () => planAnchor(props.requestId)
  const mine = (c: { on: CommentAnchor }) => c.on.kind === 'plan' && c.on.request === props.requestId
  const writing = () => {
    const d = api?.draft()
    return d && mine(d) ? d : undefined
  }
  const label = (quote: string) => {
    const t = quote.replace(/\s+/g, ' ').trim()
    return `On “${t.length > 80 ? `${t.slice(0, 80).trimEnd()}…` : t}”`
  }
  const draftBox = (d: CommentDraft) => (
    <>
      <p class="mt-2 truncate text-xs text-fg-3">{label(d.quote)}</p>
      <DraftBox
        text={api!.draftText()}
        editing={!!d.id}
        placeholder="On this…"
        onText={api!.setDraftText}
        onComment={api!.commit}
        onCancel={() => api!.setDraft(undefined)}
        onAsk={d.id ? undefined : () => api!.ask(d, api!.draftText())}
        canAsk={api!.canAsk()}
      />
    </>
  )
  let el!: HTMLDivElement
  return (
    <>
      <div ref={el} data-comments-on={on()} class={`relative ${props.class ?? ''}`}>
        {props.children}
        <Show when={api}>
          <QuoteSelection within={() => el} onComment={(quote) => api!.setDraft({ on: { kind: 'plan', request: props.requestId }, quote })} />
        </Show>
      </div>
      <Show when={api}>
        <For each={api!.all().filter(mine)}>
          {(c) => (
            <Show when={writing()?.id === c.id ? writing() : undefined} fallback={<CommentBox label={label(c.quote)} text={c.text} onEdit={() => api!.setDraft({ ...c })} onRemove={() => api!.remove(c.id)} />}>
              {(d) => draftBox(d())}
            </Show>
          )}
        </For>
        <For each={api!.asked().filter(mine)}>{(a) => <AskedItem asked={a} label={`You asked about “${label(a.quote).slice(4, -1)}”`} />}</For>
        <Show when={writing() && !writing()!.id ? writing() : undefined}>{(d) => draftBox(d())}</Show>
      </Show>
    </>
  )
}
