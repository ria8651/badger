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
    <div
      class="prose prose-zinc dark:prose-invert max-w-none prose-p:my-2 prose-pre:my-2 prose-headings:mt-4 prose-headings:mb-2 prose-li:my-0.5 text-[15px] leading-relaxed"
      innerHTML={render(props.text)}
    />
  )
}
