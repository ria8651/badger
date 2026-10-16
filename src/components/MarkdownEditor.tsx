import { createEffect, on, onCleanup, onMount } from 'solid-js'
import { Editor, Extension, InputRule } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import { TableKit } from '@tiptap/extension-table'
import Image from '@tiptap/extension-image'
import Link from '@tiptap/extension-link'
import { Paragraph as BaseParagraph } from '@tiptap/extension-paragraph'
import { Placeholder } from '@tiptap/extensions'
import { Markdown } from '@tiptap/markdown'
import { viewImageIn } from './ImageViewer.tsx'
import { askBy } from './Popover.tsx'

const SAVE_DELAY = 800

/**
 * Keeps an image on a line of its own inside its paragraph. Images are inline here, so they can sit in text too, and
 * the stock paragraph unwraps a lone image into the document, where inline content is invalid and every edit throws.
 */
const Paragraph = BaseParagraph.extend({
  parseMarkdown(token, helpers) {
    const tokens = token.tokens ?? []
    if (tokens.length === 1 && tokens[0].type === 'image') return helpers.createNode('paragraph', undefined, helpers.parseInline(tokens))
    return this.parent?.(token, helpers) ?? helpers.createNode('paragraph', undefined, helpers.parseInline(tokens))
  },
})

/** A link whose text is its own URL is written back as the bare URL, the way it was most likely typed. */
const BareLink = Link.extend({
  renderMarkdown(node, h, ctx) {
    // Marks are rendered around a placeholder; the text they cover comes separately.
    if (ctx.meta?.markText === node.attrs?.href) return h.renderChildren(node)
    return this.parent?.(node, h, ctx) ?? h.renderChildren(node)
  },
}).configure({ openOnClick: false, autolink: true, linkOnPaste: true })

/** Typing `[text](url)` makes a link, like the other Markdown shortcuts do. */
const LinkShortcut = Extension.create({
  name: 'linkShortcut',
  addInputRules: () => [
    new InputRule({
      find: /\[([^\]]+)\]\((\S+)\)$/,
      handler: ({ state, range, match }) => {
        const link = state.schema.marks.link.create({ href: match[2] })
        state.tr.replaceWith(range.from, range.to, state.schema.text(match[1], [link])).removeStoredMark(link.type)
      },
    }),
  ],
})

/** Lines that are only HTML comments; the editor would otherwise show each as an empty paragraph. */
// Each comment stops at its own `-->`, so a comment with text after it can't stretch on to a later one.
const COMMENT_LINES = /^ {0,3}(?:<!--(?:(?!-->)[\s\S])*-->[ \t]*)+(?:\n|$)/m

/** Drops comment lines, rather than leaving a blank line where each was. */
const DropComments = Extension.create({
  name: 'dropComments',
  markdownTokenizer: {
    name: 'htmlComment',
    level: 'block',
    start: (src) => src.search(COMMENT_LINES),
    tokenize: (src) => {
      const comment = COMMENT_LINES.exec(src)
      // Nothing handles this token, so it parses to nothing; as a `space` token, blank lines before a last comment would become a paragraph.
      return comment?.index === 0 ? { type: 'htmlComment', raw: comment[0] } : undefined
    },
  },
})

/** Drops the `&nbsp;` lines empty paragraphs serialize to, and runs of blank lines, leaving code blocks alone. */
const tidy = (markdown: string) =>
  markdown
    .split(/^(```[\s\S]*?^```)$/m)
    .map((part, i) => (i % 2 ? part : part.replace(/^&nbsp;$/gm, '').replace(/\n{3,}/g, '\n\n')))
    .join('')
    .trim()

/**
 * Edits Markdown as rendered text: typing `# `, `- `, `[ ] ` or `**bold**` formats in place and the syntax is never shown.
 * The text is still stored as Markdown, and only re-serialized once someone edits it, so text an agent wrote isn't
 * reformatted just by being looked at.
 */
export function MarkdownEditor(props: {
  value: string
  /** Called a moment after typing stops, and on blur. Only ever with text that was edited here. */
  onSave: (markdown: string) => void
  /** How long typing has to stop for before onSave; 0 calls it after every edit. */
  saveDelay?: number
  placeholder?: string
  class?: string
}) {
  let el!: HTMLDivElement
  let editor: Editor | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  // The Markdown this editor last loaded or saved; what comes back from the server matching it is our own echo.
  let synced = props.value
  let dirty = false

  const flush = () => {
    clearTimeout(timer)
    if (!editor || !dirty) return
    dirty = false
    synced = tidy(editor.getMarkdown())
    props.onSave(synced)
  }

  onMount(() => {
    editor = new Editor({
      element: el,
      extensions: [
        StarterKit.configure({ underline: false, link: false, paragraph: false }),
        BareLink,
        TaskList,
        TaskItem.configure({ nested: true }),
        TableKit,
        Paragraph,
        Image.configure({ inline: true }),
        LinkShortcut,
        DropComments,
        Placeholder.configure({ placeholder: () => props.placeholder ?? '' }),
        Markdown,
      ],
      content: props.value,
      contentType: 'markdown',
      editorProps: {
        attributes: { class: `md outline-none ${props.class ?? ''}` },
        handleKeyDown: (_, e) => {
          if (e.key === 'Escape') return (editor?.commands.blur(), true)
          if (e.key === 'k' && (e.metaKey || e.ctrlKey)) return (void editLink(), true)
          return false
        },
        // Links and images open with a modifier, since a plain click is for putting the cursor in or selecting them.
        handleClick: (view, __, e) => {
          if (!(e.metaKey || e.ctrlKey)) return false
          if (e.target instanceof HTMLImageElement) return (viewImageIn(view.dom, e.target), true)
          const a = (e.target as Element).closest('a')
          if (!a) return false
          window.open(a.href, '_blank', 'noreferrer')
          return true
        },
        // Or an image opens with a double click. The browser's, once the clicks are over: ProseMirror's
        // comes on the second press, so the release would land on the viewer and close it.
        handleDOMEvents: {
          dblclick: (view, e) => {
            if (!(e.target instanceof HTMLImageElement)) return false
            viewImageIn(view.dom, e.target)
            return true
          },
        },
      },
      onUpdate: () => {
        dirty = true
        clearTimeout(timer)
        timer = setTimeout(flush, props.saveDelay ?? SAVE_DELAY)
      },
      onBlur: flush,
    })
  })

  /** Asks for the URL by the selection. Emptying it takes the link off. */
  const editLink = async () => {
    if (!editor) return
    const current = editor.getAttributes('link').href as string | undefined
    const at = editor.view.coordsAtPos(editor.state.selection.from)
    const href = await askBy(new DOMRect(at.left, at.top, at.right - at.left, at.bottom - at.top), {
      label: 'Link to',
      value: current,
      placeholder: current ? 'Leave empty to remove the link' : 'https://…',
      action: current ? 'Save' : 'Add link',
    })
    if (!editor) return
    if (href === undefined) return void editor.commands.focus()
    const chain = editor.chain().focus().extendMarkRange('link')
    if (href.trim()) chain.setLink({ href: href.trim() }).run()
    else chain.unsetLink().run()
  }

  // Someone else (usually an agent) changed it. Take their text unless there are edits here not saved yet.
  createEffect(
    on(
      () => props.value,
      (value) => {
        if (!editor || value === synced || dirty) return
        synced = value
        const { from, to } = editor.state.selection
        editor.commands.setContent(value, { contentType: 'markdown', emitUpdate: false })
        const end = editor.state.doc.content.size
        if (editor.isFocused) editor.commands.setTextSelection({ from: Math.min(from, end), to: Math.min(to, end) })
      },
      { defer: true },
    ),
  )

  onCleanup(() => {
    flush()
    editor?.destroy()
  })

  return <div ref={el} />
}
