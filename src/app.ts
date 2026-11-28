import { createSignal } from 'solid-js'

/**
 * The macOS app (app/ in this repo): what it offers the page, which app/inject.js puts on `window.badgerApp` before
 * the page loads. In a browser there's none of it, and the page carries on as a web page.
 */

interface BadgerApp {
  /** The count on the Dock icon; 0 clears it. */
  setBadge(count: number): void
  /** A macOS notification. Clicking it brings the window forward, then calls `onClick`. */
  notify(title: string, body: string, onClick: () => void): void
  /** Moves the window with the mouse, from a mousedown. */
  startDrag(): void
  /** Zooms the window, or puts it back, like double-clicking a title bar. */
  toggleZoom(): void
  /** Puts the traffic lights in the sidebar's bar: in from its left edge, and centred on its middle, in points. */
  placeTrafficLights(left: number, middle: number): void
  /** The version of an update that's downloaded and waiting to be installed, if there is one. */
  updateReady(): Promise<string | null | undefined>
  /** Calls `listener` once an update's downloaded. */
  onUpdateReady(listener: (version: string) => void): void
  /** Installs the waiting update and starts the app again, asking first if that would stop chats. */
  restartToUpdate(): void
}

declare global {
  interface Window {
    badgerApp?: BadgerApp
  }
}

export const app = window.badgerApp
// For what's styled differently in the app (src/index.css).
if (app) document.documentElement.dataset.app = ''

/** The version of the app's update waiting to be installed: the sidebar offers to restart for it. */
const [updateReady, setUpdateReady] = createSignal<string>()
export { updateReady }
if (app) {
  void app.updateReady().then((version) => version && setUpdateReady(version))
  app.onUpdateReady(setUpdateReady)
}

// ── Moving the window ──

/**
 * The window has no title bar, so the page's own bars stand in for it: pane title bars (.bar) and whatever's marked
 * `data-drag-window`, from any spot in them that isn't a control, and the canvas around the panes, marked
 * `data-drag-canvas`, from itself only, as the panes and menus over it are inside it too.
 */
const DRAG = '.bar, [data-drag-window]'
const NOT_DRAG = 'button, a, input, textarea, select, label, [contenteditable="true"], [role], [draggable="true"], .xterm'

// ── The traffic lights: in the sidebar's bar, which moves with the theme's frame (its margin around the panes) ──

if (app) {
  /** Says where the bar is, once it's there; true when it was. */
  const place = () => {
    const bar = document.querySelector('[data-pane="sidebar"] .bar')?.getBoundingClientRect()
    if (bar?.height) app.placeTrafficLights(bar.left, bar.top + bar.height / 2)
    return !!bar?.height
  }
  // As soon as the sidebar's drawn, which can be after the page loads,
  const appears = new MutationObserver(() => place() && appears.disconnect())
  appears.observe(document, { childList: true, subtree: true })
  // and again after the frame changes and the page has laid out with it.
  new MutationObserver(() => requestAnimationFrame(place)).observe(document.documentElement, { attributeFilter: ['data-frame'] })
}

if (app) {
  addEventListener('mousedown', (e) => {
    const target = e.target
    if (e.button !== 0 || !(target instanceof Element) || target.closest(NOT_DRAG)) return
    if (!target.closest(DRAG) && !target.hasAttribute('data-drag-canvas')) return
    e.preventDefault()
    if (e.detail === 2) app.toggleZoom()
    else app.startDrag()
  })
}
