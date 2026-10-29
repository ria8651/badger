import { Show, createSignal, onCleanup, onMount } from 'solid-js'
import { TextQuote } from '../icons'

/**
 * Offers "Quote" once the mouse lets go of text selected inside `within`, to add it to the composer: the transcript's,
 * or a file's. It goes inside `within` and is placed against it, so it scrolls along with what's selected. `onQuote`
 * gets the range too, for working out what was picked, like which lines of a file.
 */
export function QuoteSelection(props: { within: () => HTMLElement | undefined; onQuote: (text: string, range: Range) => void }) {
  const [offer, setOffer] = createSignal<{ text: string; range: Range; x: number; y: number }>()
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
    const at = el.getBoundingClientRect()
    setOffer({ text, range: range.cloneRange(), x: end.right - at.left, y: end.bottom - at.top })
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
  return (
    <Show when={offer()}>
      {(o) => (
        <button
          type="button"
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => {
            const { text, range } = o()
            getSelection()?.removeAllRanges()
            setOffer(undefined)
            props.onQuote(text, range)
          }}
          style={{ left: `${Math.max(0, o().x - 40)}px`, top: `${o().y + 4}px` }}
          title="Add it to your message as a quote"
          class="absolute z-10 flex items-center gap-1 rounded-md bg-primary px-2 py-1 font-sans text-xs text-on-primary shadow-(--shadow-pop)"
        >
          <TextQuote class="size-3" /> Quote
        </button>
      )}
    </Show>
  )
}
