import { createSignal } from 'solid-js'

// ── Light or dark ──

const THEME_KEY = 'badger.theme'

/** Until it's toggled, the page starts out matching the OS. */
const stored = localStorage.getItem(THEME_KEY)
const [dark, setDark] = createSignal(stored ? stored === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches)

export const isDark = dark

export function toggleTheme(): void {
  setDark(!dark())
  localStorage.setItem(THEME_KEY, dark() ? 'dark' : 'light')
  // Colour transitions would fade some controls to the new theme while the rest of the page jumps.
  const root = document.documentElement
  root.classList.add('theme-switching')
  apply()
  void getComputedStyle(root).color // applies the new colours with transitions still off
  requestAnimationFrame(() => root.classList.remove('theme-switching'))
}

/** index.html does this too before anything paints, so the page doesn't flash the other theme first. */
function apply(): void {
  document.documentElement.classList.toggle('dark', dark())
  document.documentElement.style.colorScheme = dark() ? 'dark' : 'light'
}
apply()
