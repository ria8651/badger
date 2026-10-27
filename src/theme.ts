import { createMemo, createSignal } from 'solid-js'

// ── Themes: a palette (colours) and a frame (how panes sit together) ──
//
// index.css holds the tokens for each; this only picks which ones apply. index.html
// repeats the last step, resolving "system", before anything paints, from what load() saves back here.

export type Palette = 'light' | 'dark' | 'black' | 'terminal' | 'oms' | 'win95'
export type Frame = 'classic' | 'modern'
/** System follows the OS between light and dark. */
export type Mode = Palette | 'system'

export interface ThemeChoice {
  mode: Mode
  frame: Frame
}

/** A fun one is a whole look: it comes with its own frame, and the picker shows it in a section of its own. */
export const PALETTES: { id: Palette; label: string; frame?: Frame }[] = [
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
  { id: 'black', label: 'True dark' },
  { id: 'terminal', label: 'Terminal', frame: 'classic' },
  { id: 'oms', label: 'Open mSupply', frame: 'classic' },
  { id: 'win95', label: 'Windows 95', frame: 'modern' },
]
export const FRAMES: { id: Frame; label: string; description: string }[] = [
  { id: 'classic', label: 'Classic', description: 'Panes divided by lines' },
  { id: 'modern', label: 'Modern', description: 'Panes as rounded tiles' },
]

const THEME_KEY = 'badger.theme'

function load(): ThemeChoice {
  const fallback: ThemeChoice = { mode: 'system', frame: 'classic' }
  const raw = localStorage.getItem(THEME_KEY)
  // Before themes, the toggle stored just 'light' or 'dark'.
  if (raw === 'light' || raw === 'dark') return { ...fallback, mode: raw }
  try {
    return ownFrame({ ...fallback, ...JSON.parse(raw ?? '{}') })
  } catch {
    return fallback
  }
}

/** A fun palette always comes in its own frame, whatever was saved with it. */
function ownFrame(c: ThemeChoice): ThemeChoice {
  const frame = PALETTES.find((p) => p.id === c.mode)?.frame
  return frame ? { ...c, frame } : c
}

const [choice, setChoice] = createSignal(load())
// Saved back, so the copy in index.html picks the same frame before first paint next time.
localStorage.setItem(THEME_KEY, JSON.stringify(choice()))
export const themeChoice = choice

const osDark = matchMedia('(prefers-color-scheme: dark)')
const [systemIsDark, setSystemIsDark] = createSignal(osDark.matches)
osDark.addEventListener('change', (e) => {
  setSystemIsDark(e.matches)
  switchTo(apply)
})

/** The palette on screen now. */
export const palette = createMemo<Palette>(() => {
  const c = choice()
  return c.mode === 'system' ? (systemIsDark() ? 'dark' : 'light') : c.mode
})

export function setTheme(change: Partial<ThemeChoice>): void {
  setChoice(ownFrame({ ...choice(), ...change }))
  localStorage.setItem(THEME_KEY, JSON.stringify(choice()))
  switchTo(apply)
}

/** Colour transitions would fade some controls to the new theme while the rest of the page jumps. */
function switchTo(change: () => void): void {
  const root = document.documentElement
  root.classList.add('theme-switching')
  change()
  void getComputedStyle(root).color // applies the new colours with transitions still off
  requestAnimationFrame(() => root.classList.remove('theme-switching'))
}

const [applied, setApplied] = createSignal<Palette>(palette())
/** The palette the page's styles have, which changes after palette() does: for code that reads the colours themselves. */
export const appliedPalette = applied

function apply(): void {
  const root = document.documentElement
  root.dataset.palette = palette()
  root.dataset.frame = choice().frame
  setApplied(palette())
}
apply()
