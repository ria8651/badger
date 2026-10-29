/*
 * Syntax highlighting. Shiki (src/shiki.ts) loads in the background once the
 * page is idle, and each language's grammar the first time it's needed; code
 * shows plain until then.
 */

import { createEffect, createSignal, onCleanup, untrack, type Accessor } from 'solid-js'

/** Past this, code stays plain: highlighting it would stall the page. */
const MAX = 200_000

let shiki: Promise<typeof import('./shiki.ts')> | undefined
const load = () => (shiki ??= import('./shiki.ts'))
// Fetch it after first paint, so the first code block doesn't wait on it.
if (typeof window !== 'undefined') (window.requestIdleCallback ?? setTimeout)(() => void load())

const cache = new Map<string, string>()

/** Extensions whose language Shiki names differently. */
const byExtension: Record<string, string> = {
  mjs: 'js', cjs: 'js', mts: 'ts', cts: 'ts', h: 'c', hpp: 'cpp', cc: 'cpp', hh: 'cpp',
  yml: 'yaml', md: 'markdown', sh: 'shellscript', bash: 'shellscript', zsh: 'shellscript',
  rs: 'rust', py: 'python', rb: 'ruby', kt: 'kotlin', kts: 'kotlin', cs: 'csharp', fs: 'fsharp',
  ex: 'elixir', exs: 'elixir', hs: 'haskell', ml: 'ocaml', pl: 'perl', ps1: 'powershell',
  htm: 'html', svg: 'xml', plist: 'xml', conf: 'ini', cfg: 'ini', tf: 'terraform', gql: 'graphql', proto: 'protobuf',
}

/** By file name, for files whose name says more than their extension. */
const byName: Record<string, string> = {
  dockerfile: 'docker', makefile: 'make', 'cmakelists.txt': 'cmake', '.bashrc': 'shellscript',
  '.zshrc': 'shellscript', '.profile': 'shellscript', '.env': 'dotenv',
}

/** The language of a file, from its name. Shiki may not know it; then it stays plain. */
export function languageOf(path: string | undefined): string | undefined {
  const name = path?.split('/').pop()!.toLowerCase()
  if (!name) return
  if (byName[name]) return byName[name]
  const dot = name.lastIndexOf('.')
  if (dot < 0) return
  const ext = name.slice(dot + 1)
  return byExtension[ext] ?? ext
}

/**
 * Code as HTML: spans for its tokens and a <br> between lines, to go inside a
 * <pre> or <code>. Shiki escapes the code itself. Undefined when there's
 * nothing to highlight it as, or it's too long.
 */
export async function highlight(code: string, lang: string | undefined, keep = true): Promise<string | undefined> {
  if (!lang || code.length > MAX) return
  const key = `${lang}\0${code}`
  const hit = cache.get(key)
  if (hit !== undefined) return hit
  try {
    const html = await (await load()).toHtml(code, lang)
    if (html === undefined || !keep) return html
    if (cache.size > 500) cache.delete(cache.keys().next().value!)
    cache.set(key, html)
    return html
  } catch (e) {
    console.warn(`Couldn't highlight ${lang}`, e)
  }
}

/**
 * Between highlights of code that's still arriving, at least: a long file would otherwise be highlighted whole every
 * frame. Each highlight runs on the page's thread, so the gap after one is twice as long as it took, at least, leaving
 * the page free most of the time however long the file gets.
 */
const LIVE_GAP = 150

/**
 * Code highlighted as it changes, e.g. while Claude writes it: the last version highlighted and its HTML, undefined
 * until the first is done. One at a time, with a gap between (see LIVE_GAP), so what has arrived since shows plain
 * after it until the next catches up. `keep`: cache the results, which code still arriving shouldn't, as it'd push
 * out finished code.
 */
export function highlighted(code: () => string, lang: () => string | undefined, keep = true): Accessor<{ code: string; html: string } | undefined> {
  const [done, setDone] = createSignal<{ code: string; html: string }>()
  let busy = false
  let stopped = false
  /** What was last highlighted, or tried: nothing to do until one of them changes. */
  let last = ''
  const run = () => {
    const c = code()
    const l = lang()?.toLowerCase()
    if (busy || stopped || !l || !c || `${l}\0${c}` === last) return
    busy = true
    last = `${l}\0${c}`
    const started = performance.now()
    void highlight(c, l, keep).then((html) => {
      if (stopped) return
      // Nothing to highlight it as, or too long: whatever changes next gets a try straight away.
      if (html === undefined) {
        busy = false
        return
      }
      setDone({ code: c, html })
      setTimeout(
        () => {
          busy = false
          run()
        },
        Math.max(LIVE_GAP, 2 * (performance.now() - started)),
      )
    })
  }
  createEffect(() => {
    code()
    lang()
    untrack(run)
  })
  onCleanup(() => (stopped = true))
  return done
}

/** Highlights the code in an element once it scrolls near the screen. Returns a function that stops it. */
export function highlightWhenSeen(el: Element, code: string, lang: string | undefined): () => void {
  lang = lang?.toLowerCase()
  if (!lang) return () => {}
  // Already done: show it straight away, so re-rendered code doesn't flash plain.
  const hit = cache.get(`${lang}\0${code}`)
  if (hit !== undefined) {
    el.innerHTML = hit
    return () => {}
  }
  let stopped = false
  const seen = new IntersectionObserver(
    (entries) => {
      if (!entries.some((e) => e.isIntersecting)) return
      seen.disconnect()
      void highlight(code, lang).then((html) => {
        if (html !== undefined && !stopped) el.innerHTML = html
      })
    },
    { rootMargin: '400px' },
  )
  seen.observe(el)
  return () => {
    stopped = true
    seen.disconnect()
  }
}
