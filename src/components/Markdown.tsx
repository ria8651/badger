import { Marked, Renderer } from 'marked'
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

/** The text as HTML, and what its own fences are tagged with. */
function render(text: string): { html: string; fence: string } {
  fence = Math.random().toString(36).slice(2)
  return { html: DOMPurify.sanitize(md.parse(text, { async: false })), fence }
}

/** Whether the text ends inside a code fence still being written. */
const openFence = (text: string) => (text.match(/^ {0,3}(```|~~~)/gm)?.length ?? 0) % 2 === 1

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
function decorate(root: HTMLElement, text: string, fence: string, run?: (command: string) => void): () => void {
  const blocks = [...root.querySelectorAll<HTMLElement>('pre > code')]
  const open = openFence(text)
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
  createEffect(() => {
    // A diagram is drawn again in the new colours when the theme changes.
    if (hasDiagram(props.text)) appliedPalette()
    const { html, fence } = render(props.text)
    el.innerHTML = html
    const image = props.image
    if (image)
      for (const img of el.querySelectorAll('img')) {
        const src = img.getAttribute('src')
        const url = src && image(src)
        if (url) img.src = url
      }
    onCleanup(decorate(el, props.text, fence, props.runnable ? files?.run : undefined))
  })
  createEffect(() => {
    const on = wrap()
    for (const b of el.querySelectorAll<HTMLElement>('.code-wrap')) labelWrap(b, on)
  })
  return <div ref={el} class="md" classList={{ 'wrap-code': wrap() }} onClick={onClick} />
}
