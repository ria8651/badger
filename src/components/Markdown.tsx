import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { createEffect, onCleanup } from 'solid-js'
import { diagramWhenSeen } from '../diagram.ts'
import { fileLink, useOpenFile } from '../fileLinks.ts'
import { highlightWhenSeen } from '../highlight.ts'
import { appliedPalette } from '../theme.ts'
import { viewImageIn, viewImages } from './ImageViewer.tsx'

// Open links in a new tab; DOMPurify strips target unless it's set after sanitizing.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank')
    node.setAttribute('rel', 'noreferrer')
  }
})

const render = (text: string) => DOMPurify.sanitize(marked.parse(text, { gfm: true, async: false }))

/** Whether the text ends inside a code fence still being written. */
const openFence = (text: string) => (text.match(/^ {0,3}(```|~~~)/gm)?.length ?? 0) % 2 === 1

/** Whether the text has a mermaid fence, whose diagram is drawn in the palette's colours. */
const hasDiagram = (text: string) => /^ {0,3}(```|~~~)[ \t]*mermaid\b/m.test(text)

/**
 * Highlights the fenced code in rendered markdown, after DOMPurify: Shiki's
 * output is trusted, since it escapes the code itself. A fence that's still
 * streaming stays plain until it closes. Each block gets a copy button, and a
 * mermaid one is drawn as its diagram (src/diagram.ts sanitizes that itself).
 */
function decorate(root: HTMLElement, text: string): () => void {
  const blocks = [...root.querySelectorAll<HTMLElement>('pre > code')]
  const open = openFence(text)
  const stops = blocks.map((code, i) => {
    const pre = code.parentElement!
    const lang = /\blanguage-(\S+)/.exec(code.className)?.[1]?.toLowerCase()
    // A header above the code, outside what scrolls: its language, and a button to copy it.
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
    head.append(name, copy)
    pre.replaceWith(block)
    block.append(head, pre)
    if (open && i === blocks.length - 1) return () => {}
    const highlight = () => highlightWhenSeen(code, source.replace(/\n$/, ''), lang)
    if (lang !== 'mermaid') return highlight()
    return diagramWhenSeen(block, source, highlight, (url) => viewImages([url]))
  })
  return () => stops.forEach((stop) => stop())
}

export function Markdown(props: { text: string }) {
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
    el.innerHTML = render(props.text)
    onCleanup(decorate(el, props.text))
  })
  return <div ref={el} class="md" onClick={onClick} />
}
