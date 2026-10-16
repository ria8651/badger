import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { viewImageIn } from './ImageViewer.tsx'

// Open links in a new tab; DOMPurify strips target unless it's set after sanitizing.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank')
    node.setAttribute('rel', 'noreferrer')
  }
})

const render = (text: string) => DOMPurify.sanitize(marked.parse(text, { gfm: true, async: false }))

export function Markdown(props: { text: string }) {
  // Images open in the viewer, unless they're a link's.
  const onClick = (e: MouseEvent) => {
    const img = e.target as Element
    if (!(img instanceof HTMLImageElement) || img.closest('a')) return
    viewImageIn(e.currentTarget as Element, img)
  }
  return (
    <div class="md" innerHTML={render(props.text)} onClick={onClick} />
  )
}
