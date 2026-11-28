import { onCleanup } from 'solid-js'
import { recall, remember, settle } from './scrollMemory.ts'

/**
 * Keeps a scrolling element at the bottom as what's in it grows, until it's scrolled up; reaching the bottom
 * again sticks it back. For a transcript streaming in. Give the element `ref`, `onScroll` and `onWheel`, and
 * call `follow` once what grows is on the page. Given a `key`, where it was scrolled up to is remembered, for `restore`.
 * It follows only while `when` holds: a new chat's folder picker, say, is read from the top.
 */
export function createStickyScroll(key?: string, when: () => boolean = () => true) {
  let scroller!: HTMLElement
  let pinned = true
  let lastTop = 0
  let lastHeight = 0

  const fromBottom = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight
  const toBottom = () => {
    scroller.scrollTop = scroller.scrollHeight
    lastTop = scroller.scrollTop
    lastHeight = scroller.scrollHeight
  }

  return {
    ref: (el: HTMLElement) => (scroller = el),
    // Any upward move unsticks; reaching the bottom again resticks.
    onScroll: () => {
      const top = scroller.scrollTop
      const shrunk = scroller.scrollHeight < lastHeight - 0.5
      lastHeight = scroller.scrollHeight
      if (top < lastTop - 0.5) {
        // Content shrinking pulls scrollTop in to the new bottom, a thought folding up or the composer emptying on
        // send. By the scroll event what comes next may have grown it again, short of the bottom: WebKit sends the
        // event before the resize that would have followed. So moving up as it shrank isn't the reader's doing.
        if (pinned && shrunk && when()) return toBottom()
        if (fromBottom() > 1) pinned = false
      } else if (fromBottom() < 24) pinned = true
      lastTop = top
      if (key) remember(key, pinned ? undefined : top)
    },
    // Unstick on the gesture itself, before streamed content can push the bottom away.
    onWheel: (e: WheelEvent) => {
      if (e.deltaY < 0 && scroller.scrollHeight > scroller.clientHeight) pinned = false
    },
    /** Follows anything that changes size while stuck, for the owner's lifetime: messages, streaming, blocks opening. */
    follow: (...els: Element[]) => {
      const observer = new ResizeObserver(() => pinned && when() && toBottom())
      for (const el of els) observer.observe(el)
      onCleanup(() => observer.disconnect())
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
