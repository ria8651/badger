import { Marked, Renderer, type Token, type TokensList } from 'marked'
import DOMPurify from 'dompurify'
import { createEffect, onCleanup, untrack } from 'solid-js'
import { diagramWhenSeen } from '../diagram.ts'
import { fileLink, useOpenFile } from '../fileLinks.ts'
import { highlightWhenSeen } from '../highlight.ts'
import { toggleWrap, wrap } from '../prefs.ts'
import { appliedPalette } from '../theme.ts'
import { viewImageIn, viewImages } from './ImageViewer.tsx'

// Open links in a new tab; DOMPurify strips target unless it's set after sanitizing.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank')
    node.setAttribute('rel', 'noreferrer')
  }
})

/**
 * What this render's fences are tagged with, a new one each time. Only they get a Run button: a `<pre><code>`
 * written as HTML in the text can't guess it, and could hide some of what it'd run with CSS.
 */
let fence = ''
const plain = new Renderer()
const md = new Marked({
  gfm: true,
  renderer: {
    code(token) {
      return plain.code(token).replace('<code', `<code data-fence="${fence}"`)
    },
  },
})

/** Some of the text's blocks as HTML, ready to go on the page, and what its own fences are tagged with. */
function render(tokens: Token[], links: TokensList['links']): { html: DocumentFragment; fence: string } {
  fence = Math.random().toString(36).slice(2)
  const html = md.parser(Object.assign([...tokens], { links }))
  return { html: DOMPurify.sanitize(html, { RETURN_DOM_FRAGMENT: true }), fence }
}

/**
 * The text's top-level blocks, each drawn on its own. HTML written in the text can open in one block and close in a
 * later one, e.g. `<details>`, so text with any is one block.
 */
function groups(tokens: Token[]): Token[][] {
  return tokens.some((t) => t.type === 'html') ? [tokens] : tokens.map((t) => [t])
}

/** Whether the text ends inside a code fence still being written. */
const openFence = (text: string) => (text.match(/^ {0,3}(```|~~~)/gm)?.length ?? 0) % 2 === 1

/** One of the text's blocks as it's on the page, kept while its source is the same. */
interface Shown {
  /** Its source, and if it has a diagram, the colours that's drawn in. */
  key: string
  nodes: ChildNode[]
  /** Whether it has code in it, which is decorated, so it's drawn again whole rather than changed to fit. */
  code: boolean
  stop: () => void
}

/**
 * Changes `live` to match `next`, keeping what's the same: a text node that grows is added to, not replaced, so what's
 * selected in it stays selected. What's new is moved over from `next`.
 */
function morph(live: Node, next: Node) {
  if (live.nodeName !== next.nodeName) return void live.parentNode?.replaceChild(next, live)
  if (live instanceof CharacterData) {
    const to = (next as CharacterData).data
    if (live.data === to) return
    let same = 0
    while (same < live.length && same < to.length && live.data[same] === to[same]) same++
    return live.replaceData(same, live.length - same, to.slice(same))
  }
  if (!(live instanceof Element) || !(next instanceof Element)) return
  for (const a of [...live.attributes]) if (!next.hasAttribute(a.name)) live.removeAttribute(a.name)
  for (const a of next.attributes) if (live.getAttribute(a.name) !== a.value) live.setAttribute(a.name, a.value)
  const olds = [...live.childNodes]
  const news = [...next.childNodes]
  news.forEach((n, i) => (olds[i] ? morph(olds[i], n) : live.appendChild(n)))
  for (const n of olds.slice(news.length)) n.remove()
}

/** Fences whose code is shell commands, which get a button to run them. */
const SHELLS = new Set(['bash', 'sh', 'shell', 'zsh', 'console', 'shellscript'])

/** A shell fence's commands: a console one's are its `$ ` lines, without the prompt; the rest is their output. */
const commands = (source: string, lang: string) =>
  lang === 'console'
    ? source
        .split('\n')
        .filter((l) => /^\s*\$ /.test(l))
        .map((l) => l.replace(/^\s*\$ /, ''))
        .join('\n')
    : source.trim()

/** Whether the text has a mermaid fence, whose diagram is drawn in the palette's colours. */
const hasDiagram = (text: string) => /^ {0,3}(```|~~~)[ \t]*mermaid\b/m.test(text)

/** A code block's wrap button says what it'll do, like Copy says what it did. */
function labelWrap(button: HTMLElement, on: boolean) {
  button.textContent = on ? 'Unwrap' : 'Wrap'
  button.title = on ? 'Don’t wrap long lines' : 'Wrap long lines'
}

/**
 * Runs a change that resizes what's above an element, then scrolls back so it
 * stays where it was on screen. Wrapping changes every code block's height at
 * once, and the chat doesn't anchor its scroll, so the one clicked would jump.
 */
function keepInPlace(el: HTMLElement, change: () => void) {
  const before = el.getBoundingClientRect().top
  change()
  let scroller = el.parentElement
  while (scroller && !/auto|scroll/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement
  if (scroller) scroller.scrollTop += el.getBoundingClientRect().top - before
}

/**
 * Highlights the fenced code in rendered markdown, after DOMPurify: Shiki's
 * output is trusted, since it escapes the code itself. A fence that's still
 * streaming stays plain until it closes. Each block gets a copy button and a
 * wrap toggle, a shell fence a button to run it too, given `run`, and a mermaid
 * one is drawn as its diagram (src/diagram.ts sanitizes that itself).
 */
function decorate(root: ParentNode, open: boolean, fence: string, run?: (command: string) => void): () => void {
  const blocks = [...root.querySelectorAll<HTMLElement>('pre > code')]
  const stops = blocks.map((code, i) => {
    const pre = code.parentElement!
    const lang = /\blanguage-(\S+)/.exec(code.className)?.[1]?.toLowerCase()
    // A header above the code, outside what scrolls: its language, and buttons to wrap, copy and maybe run it.
    const block = document.createElement('div')
    block.className = 'code-block'
    const head = document.createElement('div')
    head.className = 'code-head'
    const name = document.createElement('span')
    name.textContent = lang ?? ''
    const copy = document.createElement('button')
    copy.textContent = 'Copy'
    copy.type = 'button'
    const source = code.textContent ?? ''
    copy.onclick = () => {
      void navigator.clipboard.writeText(source).then(() => {
        copy.textContent = 'Copied'
        setTimeout(() => (copy.textContent = 'Copy'), 1200)
      })
    }
    // One setting for every block, and files too. The .md's wrap-code class does the wrapping, so nothing's drawn again.
    const wrapping = document.createElement('button')
    wrapping.type = 'button'
    wrapping.className = 'code-wrap'
    labelWrap(wrapping, untrack(wrap))
    wrapping.onclick = () => keepInPlace(wrapping, toggleWrap)
    head.append(name, wrapping, copy)
    pre.replaceWith(block)
    block.append(head, pre)
    if (open && i === blocks.length - 1) return () => {}
    // Left of the others, so a hand going for Copy where it's always been doesn't run it.
    const command = run && code.dataset.fence === fence && lang && SHELLS.has(lang) ? commands(source, lang) : ''
    if (command) {
      const go = document.createElement('button')
      go.textContent = 'Run'
      go.type = 'button'
      go.title = 'Run in a terminal beside the chat'
      go.onclick = () => run!(command)
      head.insertBefore(go, wrapping)
    }
    const highlight = () => highlightWhenSeen(code, source.replace(/\n$/, ''), lang)
    if (lang !== 'mermaid') return highlight()
    return diagramWhenSeen(block, source, highlight, (url) => viewImages([url]))
  })
  return () => stops.forEach((stop) => stop())
}

export function Markdown(props: {
  text: string
  /** Where an image it links to is fetched from, e.g. one beside the file it's in; undefined leaves it as written. */
  image?: (src: string) => string | undefined
  /**
   * Its shell blocks get a Run button, where the chat can run them: for what Claude wrote for the user, once it's
   * all there. Not for what's written for Claude to read, e.g. skills and instructions, whose commands are its to run.
   */
  runnable?: boolean
}) {
  let el!: HTMLDivElement
  const files = useOpenFile()
  const onClick = (e: MouseEvent) => {
    // A link to a file opens it beside the chat, rather than as a page of Badger's in a new tab. Modified clicks still go there.
    const link = (e.target as Element).closest?.('a')
    const href = link?.getAttribute('href')
    if (files && href && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) {
      const to = fileLink(href, files.cwd())
      if (to) {
        e.preventDefault()
        files.open(to.path, to.line)
        return
      }
    }
    // Images open in the viewer, unless they're a link's.
    const img = e.target as Element
    if (!(img instanceof HTMLImageElement) || img.closest('a')) return
    viewImageIn(e.currentTarget as Element, img)
  }
  /**
   * Drawn block by block, and only the blocks that changed, so that as Claude writes, what's there already stays as
   * it is: highlighted, its diagrams drawn, and what's selected in it still selected. The block being written into is
   * changed to fit rather than drawn again, unless it has code in it.
   */
  let shown: Shown[] = []
  let shownLinks = ''
  const drop = (s: Shown) => {
    s.stop()
    for (const n of s.nodes) n.remove()
  }
  const clear = () => {
    shown.forEach(drop)
    shown = []
  }
  onCleanup(clear)
  createEffect(() => {
    const text = props.text
    const tokens = md.lexer(text)
    const links = JSON.stringify(tokens.links)
    // A link defined at the end can change any block that uses it.
    if (links !== shownLinks) clear()
    shownLinks = links
    // A diagram is drawn again in the new colours when the theme changes.
    const palette = hasDiagram(text) ? JSON.stringify(appliedPalette()) : ''
    const open = openFence(text)
    const image = props.image
    const run = props.runnable ? files?.run : undefined
    const all = groups(tokens)
    const next: Shown[] = []
    all.forEach((group, i) => {
      const source = group.map((t) => t.raw).join('')
      const key = palette && hasDiagram(source) ? `${source}\0${palette}` : source
      const old = shown[i]
      if (old?.key === key) return void next.push(old)
      const { html, fence } = render(group, tokens.links)
      if (image)
        for (const img of html.querySelectorAll('img')) {
          const src = img.getAttribute('src')
          const url = src && image(src)
          if (url) img.src = url
        }
      const code = !!html.querySelector('pre')
      const nodes = [...html.childNodes]
      if (old && !old.code && !code && old.nodes.length === nodes.length && old.nodes.every((n, j) => n.nodeName === nodes[j].nodeName)) {
        // Still the same kind of block, e.g. the paragraph or list being written: changed to fit.
        old.nodes.forEach((n, j) => morph(n, nodes[j]))
        return void next.push({ ...old, key, nodes: old.nodes.map((n, j) => (n.isConnected ? n : nodes[j])) })
      }
      const stop = decorate(html, open && i === all.length - 1, fence, run)
      const placed = [...html.childNodes]
      el.insertBefore(html, old?.nodes[0] ?? shown.slice(i + 1).find((s) => s.nodes.length)?.nodes[0] ?? null)
      if (old) drop(old)
      next.push({ key, nodes: placed, code, stop })
    })
    shown.slice(all.length).forEach(drop)
    shown = next
  })
  createEffect(() => {
    const on = wrap()
    for (const b of el.querySelectorAll<HTMLElement>('.code-wrap')) labelWrap(b, on)
  })
  return <div ref={el} class="md" classList={{ 'wrap-code': wrap() }} onClick={onClick} />
}
