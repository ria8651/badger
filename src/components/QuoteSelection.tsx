import { Show, createSignal, onCleanup, onMount } from 'solid-js'
import { MessageSquarePlus, TextQuote } from '../icons'

/** What's marked as one thing to comment on, by `data-comments-on`, a node is in; not in a comment shown in it. */
const commentable = (n: Node) => {
  const el = n instanceof Element ? n : n.parentElement
  return el?.closest('.comment-host') ? undefined : (el?.closest<HTMLElement>('[data-comments-on]') ?? undefined)
}

/**
 * Offers "Quote" once the mouse lets go of text selected inside `within`, to add it to the composer: the transcript's,
 * or a file's. With `onComment`, text selected within one thing marked `data-comments-on`, e.g. one of Claude's
 * replies, is offered to comment on too. It goes inside `within` and is placed against it, so it scrolls along with
 * what's selected. They get the range too, for working out what was picked, like which lines of a file.
 */
export function QuoteSelection(props: {
  within: () => HTMLElement | undefined
  onQuote?: (text: string, range: Range) => void
  onComment?: (text: string, on: HTMLElement, range: Range) => void
}) {
  const [offer, setOffer] = createSignal<{ text: string; range: Range; x: number; y: number; on?: HTMLElement }>()
  const selected = () => {
    const sel = getSelection()
    const range = sel && !sel.isCollapsed && sel.rangeCount ? sel.getRangeAt(0) : undefined
    const el = props.within()
    return range && el && el.contains(range.startContainer) && el.contains(range.endContainer) ? range : undefined
  }
  const onSelected = () => {
    const range = selected()
    const text = range?.toString().trim()
    const end = range && [...range.getClientRects()].filter((b) => b.width).at(-1)
    const el = props.within()
    if (!range || !text || !end || !el) return setOffer(undefined)
    const start = commentable(range.startContainer)
    const on = props.onComment && start && start === commentable(range.endContainer) && start.dataset.commentsOn ? start : undefined
    if (!props.onQuote && !on) return setOffer(undefined)
    const at = el.getBoundingClientRect()
    setOffer({ text, range: range.cloneRange(), x: end.right - at.left, y: end.bottom - at.top, on })
  }
  const onSelectionChange = () => offer() && !selected() && setOffer(undefined)
  onMount(() => {
    document.addEventListener('selectionchange', onSelectionChange)
    document.addEventListener('pointerup', onSelected)
    onCleanup(() => {
      document.removeEventListener('selectionchange', onSelectionChange)
      document.removeEventListener('pointerup', onSelected)
    })
  })
  const take = (f: (o: { text: string; range: Range; on?: HTMLElement }) => void) => {
    const o = offer()!
    getSelection()?.removeAllRanges()
    setOffer(undefined)
    f(o)
  }
  const button = 'flex items-center gap-1 px-2 py-1 hover:bg-white/10'
  return (
    <Show when={offer()}>
      {(o) => (
        <div
          onPointerDown={(e) => e.preventDefault()}
          style={{ left: `${Math.max(0, o().x - (o().on && props.onQuote ? 120 : 40))}px`, top: `${o().y + 4}px` }}
          class="absolute z-10 flex overflow-hidden rounded-md bg-primary font-sans text-xs text-on-primary shadow-(--shadow-pop)"
        >
          <Show when={props.onQuote}>
            <button type="button" class={button} title="Add it to your message as a quote" onClick={() => take(({ text, range }) => props.onQuote!(text, range))}>
              <TextQuote class="size-3" /> Quote
            </button>
          </Show>
          <Show when={o().on}>
            <button
              type="button"
              class={button}
              title="Comment on it. Your comments go together with your next message."
              onClick={() => take(({ text, range, on }) => props.onComment!(text, on!, range))}
            >
              <MessageSquarePlus class="size-3" /> Comment
            </button>
          </Show>
        </div>
      )}
    </Show>
  )
}
