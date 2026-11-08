import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount } from 'solid-js'
import { render } from 'solid-js/web'
import { Editor, Extension, Node, type JSONContent } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { Placeholder } from '@tiptap/extensions'
import type { Node as PMNode } from '@tiptap/pm/model'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { CommandInfo, CommandSource } from '../../shared/protocol.ts'
import { api } from '../api.ts'
import { fileLink, useOpenFile } from '../fileLinks.ts'
import { File, Folder, SquareSlash } from '../icons'
import { COMMAND, chipText, segments, spans, type Chip } from '../prompt.ts'
import { MOD } from '../layout.ts'
import { tokens, type Tokens } from '../highlight.ts'
import { PromptChip } from './PromptChip.tsx'
import { touch } from './ui.tsx'

/** What the composer can do to what's typed. */
export interface PromptInputControls {
  focus: () => void
  /** Replaces what's typed, chips and all, with the cursor at the end; focused if asked, or if it was. */
  setText: (text: string, focus?: boolean) => void
  /** Mentions these files, relative to the chat's folder or absolute, where the cursor is. */
  mention: (paths: string[]) => void
}

/** A file or command, kept whole: one keypress deletes it and the cursor steps over it. */
const ChipNode = Node.create({
  name: 'chip',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: false,
  addAttributes: () => ({ kind: { default: 'file' }, value: { default: '' } }),
  parseHTML: () => [
    {
      tag: 'span[data-chip]',
      getAttrs: (el) => ({ kind: el.dataset.chip, value: el.dataset.value }),
    },
  ],
  renderHTML: ({ node }) => ['span', { 'data-chip': node.attrs.kind, 'data-value': node.attrs.value }, chipText(node.attrs as Chip)],
  renderText: ({ node }) => chipText(node.attrs as Chip),
  addNodeView:
    () =>
    ({ node }) => {
      const dom = document.createElement('span')
      const dispose = render(() => <PromptChip chip={node.attrs as Chip} />, dom)
      return { dom, destroy: dispose, ignoreMutation: () => true }
    },
})

/** A fenced block in a language: its code, and the position each of its lines starts at. */
type Fence = { lang: string; code: string; lines: number[] }
/** What's found in a document, and the colours of its code, which come after, once they're worked out. */
type SpansState = { doc: PMNode; spans: Decoration[]; fences: Fence[]; colours: DecorationSet; all: DecorationSet }
const spansKey = new PluginKey<SpansState>('spans')

const withColours = (found: Omit<SpansState, 'colours' | 'all'>, colours: DecorationSet): SpansState => ({
  ...found,
  colours,
  all: DecorationSet.create(found.doc, [...found.spans, ...colours.find()]),
})

/**
 * Links and code shown as such, found in the text as it changes; the text itself stays plain. Code in a fenced block
 * that says its language is highlighted too, once Shiki's done it.
 */
const Spans = Extension.create({
  name: 'spans',
  addProseMirrorPlugins: () => [
    new Plugin<SpansState>({
      key: spansKey,
      state: {
        init: (_, { doc }) => withColours(findSpans(doc), DecorationSet.empty),
        apply: (tr, state) => {
          const colours = tr.getMeta(spansKey) as DecorationSet | undefined
          if (colours) return withColours(state, colours)
          if (!tr.docChanged) return state
          // Until the code's highlighted again, its colours move with the text, so they don't flash off as it's typed.
          return withColours(findSpans(tr.doc), state.colours.map(tr.mapping, tr.doc))
        },
      },
      props: {
        decorations: (state) => spansKey.getState(state)!.all,
      },
      view: (view) => {
        let asked: PMNode | undefined
        /** One at a time, a block at a time: a long block isn't highlighted again for every key typed while it's done. */
        let busy = false
        const colour = async () => {
          const { doc, fences, colours } = spansKey.getState(view.state)!
          if (busy || asked === doc || (!fences.length && colours === DecorationSet.empty)) return
          asked = doc
          busy = true
          const found: (Tokens | undefined)[] = []
          for (const f of fences) {
            if (view.isDestroyed || view.state.doc !== doc) break
            found.push(await tokens(f.code, f.lang))
          }
          busy = false
          if (view.isDestroyed) return
          // Typed on since: on to what's there now.
          if (view.state.doc !== doc) return colour()
          // Not mid-composition (IME), which redrawing the text would break; it's done after, as that changes the text.
          if (view.composing) return void (asked = undefined)
          const decorations = fences.flatMap((f, i) =>
            (found[i] ?? []).flatMap((line, l) => {
              let pos = f.lines[l]
              return line.flatMap((t) => {
                const from = pos
                pos += t.length
                return t.style && from < pos ? [Decoration.inline(from, pos, { style: t.style })] : []
              })
            }),
          )
          view.dispatch(view.state.tr.setMeta(spansKey, DecorationSet.create(doc, decorations)))
        }
        void colour()
        return { update: () => void colour() }
      },
    }),
  ],
})

function findSpans(doc: PMNode): Omit<SpansState, 'colours' | 'all'> {
  // A paragraph a line, and a chip one character, as it's one position.
  const lines: { pos: number; size: number; from: number; to: number }[] = []
  let text = ''
  doc.forEach((p, pos) => {
    if (lines.length) text += '\n'
    const line = p.textBetween(0, p.content.size, undefined, '￼')
    lines.push({ pos, size: p.nodeSize, from: text.length, to: text.length + line.length })
    text += line
  })
  /** The line an offset's on; offsets are asked in order, so it only moves on. */
  let i = 0
  const lineAt = (offset: number) => {
    while (offset > lines[i].to) i++
    return lines[i]
  }
  const pos = (offset: number) => {
    const line = lineAt(offset)
    return line.pos + 1 + offset - line.from
  }
  const decorations: Decoration[] = []
  const fences: Fence[] = []
  for (const span of spans(text)) {
    if (span.kind === 'fence') {
      const fence: Fence | undefined = span.lang ? { lang: span.lang, code: text.slice(span.code.from, span.code.to), lines: [] } : undefined
      for (let line = lineAt(span.from); ; line = lines[++i]) {
        const start = line.from === span.from
        const end = line.to === span.to
        // The fences themselves are faint beside the code.
        const edge = `${start ? ' prompt-fence-start' : ''}${end ? ' prompt-fence-end' : ''}${start || (end && span.closed) ? ' prompt-fence-mark' : ''}`
        decorations.push(Decoration.node(line.pos, line.pos + line.size, { class: `prompt-fence${edge}`, spellcheck: 'false' }))
        if (line.from >= span.code.from && line.to <= span.code.to) fence?.lines.push(line.pos + 1)
        if (line.to >= span.to) break
      }
      if (fence?.lines.length) fences.push(fence)
    } else if (span.kind === 'code') decorations.push(Decoration.inline(pos(span.from), pos(span.to), { class: 'prompt-code', spellcheck: 'false' }))
    else
      decorations.push(
        Decoration.inline(pos(span.from), pos(span.to), {
          class: 'prompt-url',
          spellcheck: 'false',
          'data-url': text.slice(span.from, span.to),
          title: `${MOD}-click to open`,
        }),
      )
  }
  return { doc, spans: decorations, fences }
}

/** The prompt as text: a line per paragraph, chips as they're written. */
function docText(doc: PMNode): string {
  const lines: string[] = []
  doc.forEach((p) => {
    let line = ''
    p.forEach((n) => (line += n.isText ? n.text : n.type.name === 'chip' ? chipText(n.attrs as Chip) : ''))
    lines.push(line)
  })
  return lines.join('\n')
}

const chipNode = (chip: Chip): JSONContent => ({ type: 'chip', attrs: chip })

/** Text as a document, with what's written as chips made into them; a command only if it's one, not one half typed. */
function textDoc(text: string, known: { command: (name: string) => boolean; file: (path: string) => boolean }): JSONContent {
  return {
    type: 'doc',
    content: text.split('\n').map((line, i) => ({
      type: 'paragraph',
      content: segments(line, { command: i === 0 && known.command, file: known.file })
        .filter((s) => s !== '')
        .map((s) => (typeof s === 'string' ? { type: 'text', text: s } : chipNode(s))),
    })),
  }
}

/** What's being completed: a command at the start, or a file after `@`, and where its text is. */
type Trigger = {
  kind: 'command' | 'file'
  query: string
  from: number
  to: number
}

type Item = { kind: 'command'; command: CommandInfo } | { kind: 'file'; path: string }

const SOURCE_LABEL: Record<CommandSource, string> = {
  project: 'Project',
  user: 'User',
  plugin: 'Plugin',
  synced: 'claude.ai',
  mcp: 'MCP',
  builtin: 'Built-in',
}
/** With nothing typed, the ones made for this project and this person come first. */
const SOURCE_ORDER: CommandSource[] = ['project', 'user', 'plugin', 'synced', 'mcp', 'builtin']

/** Each folder's commands, asked once a minute at most: listing them starts Claude Code. A failure isn't kept. */
const commandLists = new Map<string, { at: number; list: Promise<CommandInfo[]> }>()
function commandsIn(cwd: string, machine: string): Promise<CommandInfo[]> {
  const key = `${machine}\n${cwd}`
  const hit = commandLists.get(key)
  if (hit && Date.now() - hit.at < 60_000) return hit.list
  const list = api.commands(cwd, machine)
  list.catch(() => commandLists.get(key)?.list === list && commandLists.delete(key))
  commandLists.set(key, { at: Date.now(), list })
  return list
}

/** Commands matching what's typed after `/`, best first; ones another of the same name hides go after it. */
function matchCommands(all: CommandInfo[], typed: string): CommandInfo[] {
  const q = typed.toLowerCase()
  const score = (c: CommandInfo) => {
    const name = c.name.toLowerCase()
    // A hidden one ranks as the one that runs does, so the sort by name puts it straight after it.
    const runs = c.shadowed ? (all.find((o) => o.name === c.name && !o.shadowed) ?? c) : c
    if (!q) return 10 - SOURCE_ORDER.indexOf(runs.source)
    if (name.startsWith(q)) return 4
    if (name.split(/[:\-_]/).some((part) => part.startsWith(q))) return 3
    if (name.includes(q)) return 2
    return q.length > 2 && c.description.toLowerCase().includes(q) ? 1 : 0
  }
  return all
    .map((c) => [score(c), c] as const)
    .filter(([s]) => s > 0)
    .sort(([a, x], [b, y]) => b - a || x.name.localeCompare(y.name) || Number(!!x.shadowed) - Number(!!y.shadowed))
    .map(([, c]) => c)
    .slice(0, 60)
}

/**
 * Where a prompt is typed: plain text, but files picked after `@` and the command picked after `/` become chips
 * that delete in one go. The popup offers them as they're typed: commands and skills with where each comes
 * from, and the folder's files.
 */
export function PromptInput(props: {
  /** What's typed to begin with. */
  initial: string
  machine: string
  /** The chat's folder: what commands are listed for and files are found in. */
  cwd?: string
  /** Files can't be offered, e.g. in a scratch chat. */
  noFiles?: boolean
  /** What's stacked above the composer, which the popup reaches up over so none of it shows around it. */
  above?: () => HTMLElement | undefined
  placeholder: string
  disabled: boolean
  onInput: (text: string) => void
  onSubmit: () => void
  /** Keys the composer has a use for, after the popup's; true when one was. */
  onKeyDown?: (e: KeyboardEvent) => boolean
  /** True when the composer took the paste, e.g. as an image. */
  onPaste?: (e: ClipboardEvent) => boolean
  ref?: (controls: PromptInputControls) => void
  class?: string
}) {
  let el!: HTMLDivElement
  let list: HTMLDivElement | undefined
  let editor: Editor | undefined
  const files = useOpenFile()
  const [trigger, setTrigger] = createSignal<Trigger>()
  /** Where the trigger Escape closed starts; it stays closed until that one's gone. */
  const [dismissed, setDismissed] = createSignal<number>()
  /** The folder lists are for; one for another, e.g. answered after the chat moved, isn't used. */
  const where = () => `${props.machine}\n${props.cwd}`
  const [loaded, setLoaded] = createSignal<{ where: string; list: CommandInfo[] }>()
  const commands = () => (loaded()?.where === where() ? loaded()!.list : undefined)
  const [found, setFound] = createSignal<{ where: string; query: string; paths: string[] }>()
  const [selected, setSelected] = createSignal(0)
  /** Files picked here, so one with no `/` or `.` in its name, like `Makefile`, stays a chip when the text's read again. */
  const picked = new Set<string>()

  // Only when one's wanted, not on focus: listing them starts a Claude Code process.
  const loadCommands = () => {
    if (!props.cwd || commands()) return
    const at = where()
    commandsIn(props.cwd, props.machine).then(
      (list) => setLoaded({ where: at, list }),
      // Asked again the next time one's wanted.
      () => {},
    )
  }
  /** Until the list's in, nothing is one: a draft's `/word` is only made a chip once it's known to run. */
  const isCommand = (name: string) => !!commands()?.some((c) => c.name === name && !c.shadowed)
  const known = { command: isCommand, file: (path: string) => picked.has(path) }

  /** Makes the `/name` a loaded draft starts with a chip, once the commands are in, unless it's being typed. */
  const chipLoadedCommand = () => {
    const first = editor?.state.doc.firstChild?.firstChild
    const command = first?.isText ? COMMAND.exec(first.text!) : null
    if (!editor || !command || !isCommand(command[1])) return
    // The first paragraph's text starts at 1.
    const end = 1 + command[0].length
    if (editor.isFocused && editor.state.selection.from <= end) return
    const node = editor.schema.nodes.chip.create({ kind: 'command', value: command[1] })
    editor.view.dispatch(editor.state.tr.replaceWith(1, end, node).setMeta('addToHistory', false))
  }
  createEffect(on(commands, chipLoadedCommand, { defer: true }))

  // Worked out once a change, not on every read: the key handler, the list and the effects all read it.
  const items = createMemo((): Item[] => {
    const t = trigger()
    if (!t || dismissed() === t.from) return []
    if (t.kind === 'command') return matchCommands(commands() ?? [], t.query).map((command) => ({ kind: 'command', command }))
    const f = found()
    return f && f.where === where() && f.query === t.query ? f.paths.map((path) => ({ kind: 'file', path })) : []
  })
  const open = () => items().length > 0

  /**
   * What's stacked above the composer, measured as the popup opens: how far up it goes from the composer's outer
   * edge, and the composer's border. The popup and what's behind it are placed from inside that border.
   */
  const [stack, setStack] = createSignal({ height: 0, border: 0 })
  createEffect(
    on(open, (isOpen) => {
      const above = props.above?.()
      const composer = el.offsetParent
      if (isOpen && above && composer)
        setStack({ height: composer.getBoundingClientRect().top - above.getBoundingClientRect().top, border: composer.clientTop })
    }),
  )
  /** How tall the popup is to reach the top of the stack, from 8px above the composer. */
  const cover = () => stack().height + stack().border - 8
  const pickable = (i: Item) => i.kind === 'file' || !i.command.shadowed

  // Files are looked up as the query changes; an answer to an older query is dropped.
  let lookup = 0
  let lookupTimer: ReturnType<typeof setTimeout> | undefined
  createEffect(
    on(
      () => [trigger()?.kind === 'file' ? trigger()!.query : undefined, where()] as const,
      ([query, at]) => {
        clearTimeout(lookupTimer)
        if (query === undefined || !props.cwd) return
        const n = ++lookup
        lookupTimer = setTimeout(() => {
          api
            .findFiles(props.cwd!, query, props.machine)
            .then((paths) => n === lookup && setFound({ where: at, query, paths }))
            .catch(() => n === lookup && setFound({ where: at, query, paths: [] }))
        }, 60)
      },
    ),
  )
  onCleanup(() => clearTimeout(lookupTimer))
  createEffect(on(items, (now) => setSelected(Math.max(0, now.findIndex(pickable)))))
  createEffect(on(selected, (i) => list?.children[i]?.scrollIntoView({ block: 'nearest' }), { defer: true }))

  /** What the cursor is completing, if anything. */
  const findTrigger = (): Trigger | undefined => {
    if (!editor) return
    const { selection, doc } = editor.state
    if (!selection.empty) return
    const $at = selection.$from
    const before = $at.parent.textBetween(0, $at.parentOffset, undefined, '￼')
    const command = /^\/([\w:.-]*)$/.exec(before)
    if (command && doc.firstChild === $at.parent)
      return {
        kind: 'command',
        query: command[1],
        from: $at.pos - before.length,
        to: $at.pos,
      }
    const file = /(?:^|\s)@([^\s@"]*)$/.exec(before)
    if (file && !props.noFiles)
      return {
        kind: 'file',
        query: file[1],
        from: $at.pos - file[1].length - 1,
        to: $at.pos,
      }
  }
  const updateTrigger = () => {
    const t = findTrigger()
    const was = trigger()
    if (!t) setDismissed(undefined)
    if (t?.kind === 'command') loadCommands()
    if (t?.kind !== was?.kind || t?.query !== was?.query || t?.from !== was?.from) setTrigger(t)
  }

  /** Puts the item in place of what's typed for it: a chip and a space, or a folder's path to carry on into. */
  const pick = (item: Item, into = false) => {
    const t = trigger()
    if (!editor || !t || !pickable(item)) return
    const range = { from: t.from, to: t.to }
    if (item.kind === 'file' && into && item.path.endsWith('/') && !/\s/.test(item.path)) {
      editor
        .chain()
        .focus()
        .insertContentAt(range, { type: 'text', text: `@${item.path}` })
        .run()
      return
    }
    const chip: Chip = item.kind === 'file' ? { kind: 'file', value: item.path } : { kind: 'command', value: item.command.name }
    if (item.kind === 'file') picked.add(item.path)
    editor
      .chain()
      .focus()
      .insertContentAt(range, [chipNode(chip), { type: 'text', text: ' ' }])
      .run()
  }

  const move = (by: number) => {
    const all = items()
    for (let i = selected() + by; i >= 0 && i < all.length; i += by) if (pickable(all[i])) return setSelected(i)
  }

  let pasting = false
  onMount(() => {
    editor = new Editor({
      element: el,
      content: textDoc(props.initial, known),
      extensions: [
        StarterKit.configure({
          blockquote: false,
          bold: false,
          bulletList: false,
          code: false,
          codeBlock: false,
          dropcursor: false,
          gapcursor: false,
          hardBreak: false,
          heading: false,
          horizontalRule: false,
          italic: false,
          link: false,
          listItem: false,
          listKeymap: false,
          orderedList: false,
          strike: false,
          trailingNode: false,
          underline: false,
        }),
        ChipNode,
        Spans,
        Placeholder.configure({ placeholder: () => props.placeholder }),
      ],
      coreExtensionOptions: {
        clipboardTextSerializer: { blockSeparator: '\n' },
      },
      editorProps: {
        attributes: {
          class: `outline-none whitespace-pre-wrap break-words ${props.class ?? ''}`,
        },
        handleKeyDown: (_, e) => {
          if (e.isComposing) return false
          if (open()) {
            const item = items()[selected()]
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') return (move(e.key === 'ArrowDown' ? 1 : -1), true)
            if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey && item && pickable(item)) return (pick(item, e.key === 'Tab'), true)
            if (e.key === 'Escape') return (setDismissed(trigger()?.from), true)
          }
          if (e.key === 'Enter' && e.shiftKey) return editor!.commands.splitBlock()
          // Phone keyboards have no Shift+Enter, so there Enter is a newline and the button sends.
          if (e.key === 'Enter' && !touch.matches) return (props.onSubmit(), true)
          return props.onKeyDown?.(e) ?? false
        },
        // As plain text, a paragraph a line, whatever else was copied with it.
        handlePaste: (view, e) => {
          if (pasting) return false
          if (props.onPaste?.(e)) return true
          const text = e.clipboardData?.getData('text/plain')
          if (!text) return false
          pasting = true
          try {
            view.pasteText(text)
          } finally {
            pasting = false
          }
          return true
        },
        // Dropped files are the composer's to attach.
        handleDrop: (_, e) => !!(e as DragEvent).dataTransfer?.files.length,
        // A link opens with a modifier, since a plain click is for putting the cursor in it.
        handleClick: (_, __, e) => {
          const url = (e.metaKey || e.ctrlKey) && (e.target as Element).closest<HTMLElement>('[data-url]')?.dataset.url
          if (url) window.open(url, '_blank', 'noreferrer')
          return !!url
        },
        handleClickOn: (_, __, node) => {
          if (node.type.name !== 'chip' || node.attrs.kind !== 'file' || !files) return false
          const link = fileLink(node.attrs.value, files.cwd())
          if (link) files.open(link.path, link.line)
          return !!link
        },
      },
      onUpdate: () => props.onInput(docText(editor!.state.doc)),
      onTransaction: updateTrigger,
      onFocus: () => setDismissed(undefined),
      onBlur: () => setDismissed(trigger()?.from),
    })
    if (props.initial.startsWith('/')) loadCommands()
  })
  // Dropped as well as destroyed: a focus kept from before, like a side chat pane's, mustn't reach a dead editor.
  onCleanup(() => {
    editor?.destroy()
    editor = undefined
  })

  // Not as an update: that would save the empty editor over the draft before it's loaded.
  createEffect(() => editor?.setEditable(!props.disabled, false))
  // The placeholder is drawn on the next update; this makes one when it changes.
  createEffect(
    on(
      () => props.placeholder,
      () => editor?.view.dispatch(editor.state.tr),
      { defer: true },
    ),
  )

  props.ref?.({
    focus: () => editor?.commands.focus(),
    setText: (text, focus) => {
      if (!editor) return
      // The draft coming back as saved is what's here already, and mustn't move the cursor.
      const same = text === docText(editor.state.doc)
      if (!same) editor.commands.setContent(textDoc(text, known), { emitUpdate: false })
      if (!same && text.startsWith('/')) loadCommands()
      if (focus || (!same && editor.isFocused)) editor.commands.focus('end')
    },
    mention: (paths) => {
      if (!editor || !paths.length) return
      const { $from } = editor.state.selection
      const after = $from.parent.textBetween(0, $from.parentOffset, undefined, '￼')
      const content: JSONContent[] = after && !/\s$/.test(after) ? [{ type: 'text', text: ' ' }] : []
      for (const path of paths) picked.add(path)
      for (const path of paths)
        content.push(chipNode({ kind: 'file', value: path }), {
          type: 'text',
          text: ' ',
        })
      editor.chain().focus().insertContent(content).run()
    },
  })

  return (
    <>
      <Show when={open()}>
        {/* Square behind the popup's round corners, so none of what it covers shows past them, nor in the gap. */}
        {/* From the composer's outer edge up, so it doesn't cover the composer's own border. */}
        <Show when={cover() > 0}>
          <div
            onMouseDown={(e) => e.preventDefault()}
            class="absolute -inset-x-px z-10 bg-bg"
            style={{ bottom: `calc(100% + ${stack().border}px)`, height: `${stack().height}px` }}
          />
        </Show>
        <div
          // Pressing in the list mustn't take the focus from the editor.
          onMouseDown={(e) => e.preventDefault()}
          style={{
            'min-height': cover() > 0 ? `${cover()}px` : undefined,
            'max-height': `max(18rem, ${cover()}px)`,
          }}
          class="absolute -inset-x-px bottom-full z-10 mb-2 flex origin-bottom animate-[pop-in_120ms_ease-out] flex-col overflow-y-auto rounded-composer border border-edge bg-bg p-1 pop shadow-(--shadow-pop)"
        >
          {/* Down by the composer when there are only a few; the space above is only there to cover what's stacked there. */}
          <div ref={list} class="mt-auto">
            <For each={items()}>
              {(item, i) => (
                <button
                  type="button"
                  onClick={() => pick(item)}
                  onMouseMove={() => pickable(item) && setSelected(i())}
                  // Its corners are the popup's less the padding between them, so the two curves run together.
                  // Scrolled to, it stops that padding short of the edge, as the first and last do.
                  class={`flex w-full min-w-0 scroll-my-1 items-center gap-2 rounded-xl px-2.5 py-1.5 text-left pointer-coarse:py-2.5 ${
                    i() === selected() ? 'bg-surface' : ''
                  } ${pickable(item) ? '' : 'cursor-default opacity-50'}`}
                >
                  {item.kind === 'command' ? <CommandRow command={item.command} all={commands() ?? []} /> : <FileRow path={item.path} />}
                </button>
              )}
            </For>
          </div>
        </div>
      </Show>
      <div ref={el} />
    </>
  )
}

function CommandRow(props: { command: CommandInfo; all: CommandInfo[] }) {
  const c = () => props.command
  /** The one that runs instead of this one. */
  const runs = () => (c().shadowed ? props.all.find((o) => o.name === c().name && !o.shadowed) : undefined)
  return (
    <>
      <SquareSlash class="size-3.5 shrink-0 text-fg-3" />
      <span class="max-w-[60%] shrink-0 truncate text-ui text-fg">/{c().name}</span>
      <Show when={c().argumentHint}>
        <span class="hidden max-w-[30%] min-w-0 truncate text-xs text-fg-3 @md:inline">{c().argumentHint}</span>
      </Show>
      <span class="min-w-0 flex-1 truncate text-xs text-fg-3" title={c().path}>
        {runs() ? `Not run: /${c().name} runs the ${SOURCE_LABEL[runs()!.source].toLowerCase()} one` : c().description}
      </span>
      <span class="shrink-0 rounded-md border border-edge px-1.5 text-[11px] leading-4 text-fg-3" title={c().path ?? c().origin}>
        {SOURCE_LABEL[c().source]}
      </span>
    </>
  )
}

function FileRow(props: { path: string }) {
  const folder = () => props.path.endsWith('/')
  const cut = () => props.path.replace(/\/$/, '').lastIndexOf('/') + 1
  return (
    <>
      <Show when={folder()} fallback={<File class="size-3.5 shrink-0 text-fg-3" />}>
        <Folder class="size-3.5 shrink-0 text-fg-3" />
      </Show>
      {/* The name is what's looked for; a long folder path gives way first. */}
      <span class="flex min-w-0 text-ui">
        <span class="truncate text-fg-3">{props.path.slice(0, cut())}</span>
        <span class="shrink-0 text-fg">{props.path.slice(cut())}</span>
      </span>
    </>
  )
}
