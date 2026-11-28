import { onCleanup } from 'solid-js'
import { recall, remember, settle } from './scrollMemory.ts'

/** How long after the reader's wheel, keys or letting go a move up is still theirs: a smooth or momentum scroll. */
const READER_GRACE_MS = 1000
/** How long after what's in it changes a move up can be that change's doing rather than the reader's. */
const CHANGE_GRACE_MS = 200
/** Pressing these sends, folds or types rather than scrolls, and what they change shouldn't count as the reader's. */
const CONTROLS = 'button, a, input, textarea, select, label, [contenteditable="true"], [role="button"]'
const SCROLL_KEYS = new Set(['ArrowUp', 'PageUp', 'Home', ' '])
const onControl = (e: Event) => e.target instanceof Element && !!e.target.closest(CONTROLS)
const RELEASES = ['pointerup', 'pointercancel', 'pointermove', 'touchend', 'touchcancel']

/**
 * Keeps a scrolling element at the bottom as what's in it grows, until it's scrolled up; reaching the bottom
 * again sticks it back. For a transcript streaming in. Give the element `ref`, `onScroll` and `onWheel`, and
 * call `follow` once what grows is on the page; to scroll it up from code, `unpin` first. Given a `key`, where it
 * was scrolled up to is remembered, for `restore`.
 * It follows only while `when` holds: a new chat's folder picker, say, is read from the top.
 */
export function createStickyScroll(key?: string, when: () => boolean = () => true) {
  let scroller!: HTMLElement
  let pinned = true
  let lastTop = 0
  /** When the reader last did something that scrolls, and whether they're still holding on: a drag or a touch. */
  let touchedAt = -Infinity
  let holding = false
  const readerMoved = () => holding || performance.now() - touchedAt < READER_GRACE_MS
  /** When what's in it last changed: streamed in, opened or folded. */
  let changedAt = -Infinity
  const changed = () => (changedAt = performance.now())
  const justChanged = () => performance.now() - changedAt < CHANGE_GRACE_MS

  const fromBottom = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight
  const toBottom = () => {
    scroller.scrollTop = scroller.scrollHeight
    lastTop = scroller.scrollTop
  }
  const touched = () => (touchedAt = performance.now())
  /** Holds on till the button or finger's let go. WebKit can miss the pointerup after a scrollbar drag, so a move with
   *  no button down lets go too. */
  const hold = () => {
    if (holding) return
    holding = true
    touched()
    const release = (e: Event) => {
      if (e instanceof PointerEvent && e.type === 'pointermove' && e.buttons) return
      holding = false
      touched()
      for (const type of RELEASES) removeEventListener(type, release)
    }
    for (const type of RELEASES) addEventListener(type, release)
  }
  // Keys scroll it wherever the focus is, short of something being typed in.
  const onKey = (e: KeyboardEvent) => {
    if (SCROLL_KEYS.has(e.key) && !(e.target instanceof Element && e.target.closest('input, textarea, select, [contenteditable="true"]'))) touched()
  }
  document.addEventListener('keydown', onKey)
  onCleanup(() => document.removeEventListener('keydown', onKey))

  return {
    ref: (el: HTMLElement) => {
      scroller = el
      // What the reader can scroll it with besides the wheel and keys: the scrollbar or selecting past the edge (a mouse
      // press, but not on a control, whose clicks fold and send), or a finger moving, wherever it started.
      el.addEventListener('pointerdown', (e) => e.pointerType === 'mouse' && !onControl(e) && hold())
      el.addEventListener('touchmove', hold, { passive: true })
    },
    // Moving up unsticks; reaching the bottom again resticks.
    onScroll: () => {
      const top = scroller.scrollTop
      if (top < lastTop - 0.5) {
        // Unless it's what's in it changing, not the reader: content shrinking pulls scrollTop in, a thought folding up
        // or the composer emptying on send, and in WebKit the scroll event can come after what follows has grown it
        // again, short of the bottom.
        if (pinned && justChanged() && !readerMoved() && when()) return toBottom()
        if (fromBottom() > 1) pinned = false
      } else if (fromBottom() < 24) pinned = true
      lastTop = top
      if (key) remember(key, pinned ? undefined : top)
    },
    // Unstick on the gesture itself, before streamed content can push the bottom away.
    onWheel: (e: WheelEvent) => {
      touched()
      if (e.deltaY < 0 && scroller.scrollHeight > scroller.clientHeight) pinned = false
    },
    /** Follows anything that changes size while stuck, for the owner's lifetime: messages, streaming, blocks opening. */
    follow: (...els: Element[]) => {
      const observer = new ResizeObserver(() => {
        changed()
        if (pinned && when()) toBottom()
      })
      // A resize is only seen after the scroll it causes, so changes are also noted as they're made.
      const mutations = new MutationObserver(changed)
      for (const el of els) {
        observer.observe(el)
        mutations.observe(el, { childList: true, characterData: true, subtree: true })
      }
      onCleanup(() => {
        observer.disconnect()
        mutations.disconnect()
      })
    },
    /** Sticks it to the bottom and goes there, e.g. on sending. */
    pin: () => {
      pinned = true
      toBottom()
    },
    /** Lets it go, e.g. to scroll to something further up. */
    unpin: () => (pinned = false),
    /** Goes back to where it was scrolled up to last time, if it was, once `content` is on the page. */
    restore: (content: Element) => {
      const top = key ? recall<number>(key) : undefined
      if (top === undefined) return
      pinned = false
      settle(scroller, content, () => {
        scroller.scrollTop = top
        lastTop = scroller.scrollTop
      })
    },
  }
}
