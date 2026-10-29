import { Show, createEffect, createSignal, on, onCleanup, onMount } from 'solid-js'
import { Portal } from 'solid-js/web'
import { ChevronLeft, ChevronRight, Download, X, ZoomIn, ZoomOut } from '../icons'
import { openModal } from './ui.tsx'

const [shown, setShown] = createSignal<{ urls: string[]; index: number }>()

/** Shows these images full screen, starting at this one; the rest are a step away with the arrows. */
export function viewImages(urls: string[], index = 0) {
  if (urls.length) setShown({ urls, index: Math.max(0, Math.min(index, urls.length - 1)) })
}

/** Shows this image from rendered Markdown, with the others in the same document beside it. */
export function viewImageIn(container: Element, image: HTMLImageElement) {
  // Not the editor's own invisible ones, which keep the cursor's place beside inline images.
  const images = [...container.querySelectorAll('img:not(.ProseMirror-separator)')] as HTMLImageElement[]
  viewImages(
    images.map((i) => i.src),
    images.indexOf(image),
  )
}

const MAX_SCALE = 16
const STEP = 1.5

/**
 * The one place images open full size: attachments, what tools showed Claude, and
 * images in Markdown. Mounted once in App. Scrolling, pinching or the buttons zoom
 * toward the pointer, dragging pans, and double-clicking flips between fitting the
 * screen and actual size. Clicking anywhere but the image or a button closes it.
 */
export function ImageViewer() {
  return (
    <Show when={shown()}>
      {(s) => <Viewer urls={s().urls} index={s().index} onClose={() => setShown(undefined)} />}
    </Show>
  )
}

function Viewer(props: { urls: string[]; index: number; onClose: () => void }) {
  let stage!: HTMLDivElement
  let img!: HTMLImageElement
  const [index, setIndex] = createSignal(props.index)
  const [scale, setScale] = createSignal(1)
  const [pan, setPan] = createSignal({ x: 0, y: 0 })
  const [dragging, setDragging] = createSignal(false)
  /** Whether the image eases to its next place: for steps like a button or a wheel's notch, not for following fingers. */
  const [smooth, setSmooth] = createSignal(false)
  const url = () => props.urls[index()]
  const many = () => props.urls.length > 1

  // Shortcuts behind this leave its keys be, as for any modal.
  onCleanup(openModal().release)

  const reset = () => {
    setSmooth(true)
    setScale(1)
    setPan({ x: 0, y: 0 })
  }
  createEffect(on(index, reset, { defer: true }))
  const step = (by: number) => many() && setIndex((i) => (i + by + props.urls.length) % props.urls.length)

  /** Keeps the image covering the screen once it's bigger than it, so it can't be dragged away. */
  const clamp = (p: { x: number; y: number }, s: number) => {
    const maxX = Math.max(0, (img.offsetWidth * s - stage.clientWidth) / 2)
    const maxY = Math.max(0, (img.offsetHeight * s - stage.clientHeight) / 2)
    return { x: Math.max(-maxX, Math.min(maxX, p.x)), y: Math.max(-maxY, Math.min(maxY, p.y)) }
  }

  /** Zooms to this scale, keeping the point under (clientX, clientY), or the middle, where it is. */
  const zoomTo = (next: number, clientX?: number, clientY?: number, ease = true) => {
    setSmooth(ease)
    next = Math.max(1, Math.min(MAX_SCALE, next))
    const r = stage.getBoundingClientRect()
    const mx = clientX === undefined ? 0 : clientX - r.left - r.width / 2
    const my = clientY === undefined ? 0 : clientY - r.top - r.height / 2
    const k = next / scale()
    const p = pan()
    setPan(clamp({ x: mx - (mx - p.x) * k, y: my - (my - p.y) * k }, next))
    setScale(next)
  }

  /** How far to zoom for the image's own pixels, at least double so it's always a visible step. */
  const actualSize = () => Math.max(2, img.naturalWidth / img.offsetWidth)

  const onWheel = (e: WheelEvent) => {
    e.preventDefault()
    // Chrome and Firefox send trackpad pinches as wheel events with ctrlKey, in finer steps than scrolling.
    const lines = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? 40 : 1
    const by = e.deltaY * lines * (e.ctrlKey ? 0.01 : 0.002)
    // A mouse wheel's notch is a big step, eased; a trackpad's small ones follow the fingers.
    zoomTo(scale() * Math.exp(-by), e.clientX, e.clientY, Math.abs(by) > 0.1)
  }

  // Safari sends trackpad pinches as gesture events instead, with the scale since the pinch began.
  let pinchFrom = 1
  type Gesture = UIEvent & { scale: number; clientX: number; clientY: number }
  const onGestureStart = (e: Event) => {
    e.preventDefault()
    pinchFrom = scale()
  }
  const onGestureChange = (e: Event) => {
    e.preventDefault()
    const g = e as Gesture
    zoomTo(pinchFrom * g.scale, g.clientX, g.clientY, false)
  }
  onMount(() => {
    stage.addEventListener('gesturestart', onGestureStart)
    stage.addEventListener('gesturechange', onGestureChange)
    stage.addEventListener('gestureend', (e) => e.preventDefault())
  })

  // Pointers down on the stage: one drags, two pinch.
  const pointers = new Map<number, { x: number; y: number }>()
  /**
   * How far the pointer has gone since it went down, so a drag isn't taken for a click. Endless until
   * it goes down here, as the click that opened this (a double click in the editor) can end on it.
   */
  let travel = Infinity
  const spread = () => {
    const [a, b] = [...pointers.values()]
    return { d: Math.hypot(a.x - b.x, a.y - b.y), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
  }
  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0 || (e.target as Element).closest('button, a')) return
    stage.setPointerCapture(e.pointerId)
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pointers.size === 1) travel = 0
    setDragging(true)
  }
  const onPointerMove = (e: PointerEvent) => {
    const last = pointers.get(e.pointerId)
    if (!last) return
    if (pointers.size === 2) {
      const before = spread()
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
      const after = spread()
      travel = Infinity
      zoomTo(scale() * (after.d / before.d), after.x, after.y, false)
      setPan((p) => clamp({ x: p.x + after.x - before.x, y: p.y + after.y - before.y }, scale()))
      return
    }
    const dx = e.clientX - last.x
    const dy = e.clientY - last.y
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
    travel += Math.abs(dx) + Math.abs(dy)
    setSmooth(false)
    if (scale() > 1) setPan((p) => clamp({ x: p.x + dx, y: p.y + dy }, scale()))
  }
  const onPointerUp = (e: PointerEvent) => {
    pointers.delete(e.pointerId)
    if (!pointers.size) setDragging(false)
  }
  // By position: with the pointer captured, clicks land on the stage rather than the image.
  const onImage = (e: MouseEvent) => {
    const r = img.getBoundingClientRect()
    return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom
  }
  // A click beside the image that wasn't a drag closes it, the toolbar's bare stretch included.
  const onClick = (e: MouseEvent) => {
    if (travel < 5 && !onImage(e) && !(e.target as Element).closest('button, a')) props.onClose()
  }
  const onDoubleClick = (e: MouseEvent) => {
    if (!onImage(e) || (e.target as Element).closest('button, a')) return
    if (scale() > 1) reset()
    else zoomTo(actualSize(), e.clientX, e.clientY)
  }

  // Caught first and stopped, so Escape closes this rather than also stopping Claude from the composer.
  const onKey = (e: KeyboardEvent) => {
    const act: Record<string, () => void> = {
      Escape: props.onClose,
      ArrowLeft: () => step(-1),
      ArrowRight: () => step(1),
      '+': () => zoomTo(scale() * STEP),
      '=': () => zoomTo(scale() * STEP),
      '-': () => zoomTo(scale() / STEP),
      '0': reset,
    }
    const run = act[e.key]
    if (!run || e.metaKey || e.ctrlKey || e.altKey) return
    e.preventDefault()
    e.stopPropagation()
    run()
  }
  addEventListener('keydown', onKey, true)
  onCleanup(() => removeEventListener('keydown', onKey, true))

  const extension = () => url().match(/^data:image\/(\w+)/)?.[1]?.replace('jpeg', 'jpg') ?? url().split(/[?#]/)[0].split('.').pop() ?? 'png'
  const button = 'grid size-9 place-items-center rounded-full text-white/80 transition-colors hover:bg-white/15 hover:text-white disabled:opacity-40 disabled:hover:bg-transparent'

  return (
    <Portal>
      <div class="fixed inset-0 z-50 flex animate-[fade-in_120ms_ease-out] flex-col bg-black/90 select-none" role="dialog" aria-label="Image">
        <div
          ref={stage}
          class={`relative flex min-h-0 flex-1 touch-none items-center justify-center overflow-hidden px-4 pt-13 pb-4 ${
            scale() > 1 ? (dragging() ? 'cursor-grabbing' : 'cursor-grab') : ''
          }`}
          onWheel={onWheel}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onClick={onClick}
          onDblClick={onDoubleClick}
        >
          {/* Over the stage rather than above it, so a click on its bare stretch closes like any beside the image. */}
          <div class="absolute inset-x-0 top-0 z-10 flex items-center gap-1 px-3 py-2 bg-linear-to-b from-black/60 text-white/80">
            <Show when={many()}>
              <span class="px-2 text-xs tabular-nums">
                {index() + 1} / {props.urls.length}
              </span>
            </Show>
            <div class="flex-1" />
            <button type="button" class={button} title="Zoom out (−)" disabled={scale() <= 1} onClick={() => zoomTo(scale() / STEP)}>
              <ZoomOut class="size-4" />
            </button>
            <button type="button" class="h-9 min-w-14 rounded-full px-2 text-xs tabular-nums hover:bg-white/15 hover:text-white" title="Fit to screen (0)" onClick={reset}>
              {Math.round(scale() * 100)}%
            </button>
            <button type="button" class={button} title="Zoom in (+)" disabled={scale() >= MAX_SCALE} onClick={() => zoomTo(scale() * STEP)}>
              <ZoomIn class="size-4" />
            </button>
            <a class={button} href={url()} download={`image.${extension()}`} title="Download">
              <Download class="size-4" />
            </a>
            <button type="button" class={button} title="Close (Esc)" onClick={props.onClose}>
              <X class="size-4" />
            </button>
          </div>
          <img
            ref={img}
            src={url()}
            alt=""
            draggable={false}
            class={`max-h-full max-w-full rounded-lg shadow-2xl ${smooth() ? 'transition-transform duration-150 ease-out' : ''} ${scale() > 1 ? '' : 'cursor-zoom-in'}`}
            style={{ transform: `translate(${pan().x}px, ${pan().y}px) scale(${scale()})` }}
          />
          <Show when={many()}>
            <button type="button" class={`${button} absolute left-3 bg-black/40`} title="Previous (←)" onClick={(e) => (e.stopPropagation(), step(-1))}>
              <ChevronLeft class="size-5" />
            </button>
            <button type="button" class={`${button} absolute right-3 bg-black/40`} title="Next (→)" onClick={(e) => (e.stopPropagation(), step(1))}>
              <ChevronRight class="size-5" />
            </button>
          </Show>
        </div>
      </div>
    </Portal>
  )
}
