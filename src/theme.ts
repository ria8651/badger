import { createMemo, createSignal } from 'solid-js'

// ── Themes: a palette (colours) and a frame (how panes sit together) ──
//
// index.css holds the tokens for each; this only picks which ones apply. index.html
// repeats the choosing before anything paints, so the page doesn't flash another theme first.

export type Palette = 'light' | 'dark' | 'black'
export type Frame = 'classic' | 'modern'
/** System follows the OS between light and dark. */
export type Mode = Palette | 'system'

export interface ThemeChoice {
  mode: Mode
  frame: Frame
}

export const PALETTES: { id: Palette; label: string }[] = [
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
  { id: 'black', label: 'True dark' },
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
    return { ...fallback, ...JSON.parse(raw ?? '{}') }
  } catch {
    return fallback
  }
}

const [choice, setChoice] = createSignal(load())
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
export const isDark = () => palette() !== 'light'

export function setTheme(change: Partial<ThemeChoice>): void {
  setChoice({ ...choice(), ...change })
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

function apply(): void {
  const root = document.documentElement
  root.dataset.palette = palette()
  root.dataset.frame = choice().frame
  root.style.colorScheme = isDark() ? 'dark' : 'light'
}
apply()
