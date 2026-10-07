import { marked } from 'marked'
import DOMPurify from 'dompurify'

// Open links in a new tab; DOMPurify strips target unless it's set after sanitizing.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank')
    node.setAttribute('rel', 'noreferrer')
  }
})

const render = (text: string) => DOMPurify.sanitize(marked.parse(text, { gfm: true, async: false }))

export function Markdown(props: { text: string }) {
  return (
    <div class="md" innerHTML={render(props.text)} />
  )
}
