import { createEffect, createRoot, createSignal } from 'solid-js'

// ── The sidebar's width on wide screens ──
//
// Here rather than in App so a chat's panels can drag it too, where their
// gutters meet its edge. Narrow screens use a fixed drawer.

const KEY = 'badger.sidebarWidth'
export const SIDEBAR_DEFAULT = 256

const [sidebarWidth, setWidth] = createSignal(Number(localStorage.getItem(KEY)) || SIDEBAR_DEFAULT)
createRoot(() => createEffect(() => localStorage.setItem(KEY, String(sidebarWidth()))))
export { sidebarWidth }

export const setSidebarWidth = (w: number) => setWidth(Math.round(Math.max(200, Math.min(480, w))))

/** Follows the pointer from a press on the sidebar's edge, until it's let go. */
export function dragSidebar(e: PointerEvent): (m: PointerEvent) => void {
  const start = e.clientX - sidebarWidth()
  return (m) => setSidebarWidth(m.clientX - start)
}
