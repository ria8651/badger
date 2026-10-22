import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { createEffect, onCleanup } from 'solid-js'
import { highlightWhenSeen } from '../highlight.ts'
import { viewImageIn } from './ImageViewer.tsx'

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

/**
 * Highlights the fenced code in rendered markdown, after DOMPurify: Shiki's
 * output is trusted, since it escapes the code itself. A fence that's still
 * streaming stays plain until it closes. Each block gets a copy button.
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
    return highlightWhenSeen(code, source.replace(/\n$/, ''), lang)
  })
  return () => stops.forEach((stop) => stop())
}

export function Markdown(props: { text: string }) {
  let el!: HTMLDivElement
  // Images open in the viewer, unless they're a link's.
  const onClick = (e: MouseEvent) => {
    const img = e.target as Element
    if (!(img instanceof HTMLImageElement) || img.closest('a')) return
    viewImageIn(e.currentTarget as Element, img)
  }
  createEffect(() => {
    el.innerHTML = render(props.text)
    onCleanup(decorate(el, props.text))
  })
  return <div ref={el} class="md" onClick={onClick} />
}
