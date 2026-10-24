/*
 * Where things were scrolled to, by key (a chat, a diff review), so coming back to one, or reloading, finds it where it
 * was left. Kept in localStorage for the latest few hundred.
 */

const STORAGE = 'badger.scroll'
const MAX = 300

type Spots = Record<string, { at: number; spot: unknown }>

let spots: Spots = (() => {
  try {
    return JSON.parse(localStorage.getItem(STORAGE) ?? '{}') as Spots
  } catch {
    return {}
  }
})()

let timer: ReturnType<typeof setTimeout> | undefined
const save = () => {
  clearTimeout(timer)
  timer = setTimeout(() => {
    const kept = Object.entries(spots).sort((a, b) => b[1].at - a[1].at).slice(0, MAX)
    spots = Object.fromEntries(kept)
    localStorage.setItem(STORAGE, JSON.stringify(spots))
  }, 300)
}
addEventListener('pagehide', () => timer && (clearTimeout(timer), localStorage.setItem(STORAGE, JSON.stringify(spots))))

export function recall<T>(key: string): T | undefined {
  return spots[key]?.spot as T | undefined
}

/** Undefined forgets it, e.g. for a chat back at its bottom, where it would go anyway. */
export function remember(key: string, spot: unknown): void {
  if (spot === undefined) delete spots[key]
  else spots[key] = { at: Date.now(), spot }
  save()
}

/**
 * Scrolls `scroller` with `place`, now and again whenever `content` changes size while it settles (images loading, code
 * being highlighted, hunks drawn for the first time), until the user scrolls themselves or a few seconds pass.
 */
export function settle(scroller: HTMLElement, content: Element, place: () => void, ms = 3000): () => void {
  place()
  const observer = new ResizeObserver(() => place())
  observer.observe(content)
  const stop = () => {
    observer.disconnect()
    clearTimeout(timeout)
    for (const e of ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const) scroller.removeEventListener(e, stop)
  }
  for (const e of ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const) scroller.addEventListener(e, stop, { passive: true })
  const timeout = setTimeout(stop, ms)
  return stop
}
