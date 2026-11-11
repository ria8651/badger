import { For, Index, Show, createEffect, createMemo, createResource, createSelector, createSignal, on, onMount, type JSX } from 'solid-js'
import { RotateCw, TextWrap } from '../icons'
import type { CommentAnchor, DraftComment, ReviewDiff } from '../../shared/protocol.ts'
import { api } from '../api.ts'
import { changedLines } from '../diffRows.ts'
import { plural } from '../format.ts'
import { toggleWrap, wrap } from '../prefs.ts'
import { highlight, languageOf } from '../highlight.ts'
import { CodeRow } from './CodeRow.tsx'
import { CommentBox, DraftBox } from './Comments.tsx'
import { useComments, type Asked, type CommentDraft } from '../comments.ts'
import { AskedItem } from './ReplyComments.tsx'
import { QuoteSelection } from './QuoteSelection.tsx'
import { Breadcrumbs } from './Breadcrumbs.tsx'
import { Markdown } from './Markdown.tsx'
import { OpenFile, fileLink, useOpenFile } from '../fileLinks.ts'
import { DiffCount, GhostButton, PaneBar, Segmented } from './ui.tsx'

/** Lines drawn per block; blocks off screen skip layout, so a long file costs little until it's scrolled through. */
const BLOCK = 200
/** Past this many lines, a file shows its start: drawing every line of a big log would hang the tab. */
const MAX_LINES = 20_000
/** The images the server sends as images; anything else, an SVG say, comes as text. */
const IMAGE = /\.(png|jpe?g|gif|webp)$/i

/** How much further in than its line a wrapped line's later rows start. */
const HANG = 2
/** Columns between tab stops: Tailwind's base styles make it 4, not the browser's 8. */
const TAB = 4

/** What's drawn rendered rather than as its source, unless a line in it is asked for. */
const MARKDOWN = /\.(md|markdown|mdx)$/i

export type FileMode = 'file' | 'rendered' | 'diff'

/** How a file opens: Markdown rendered, to read, unless it's opened at a line, which only its source has. */
export const openingMode = (path: string, line?: number): FileMode => (MARKDOWN.test(path) && !line ? 'rendered' : 'file')

const dirOf = (path: string) => path.slice(0, path.lastIndexOf('/')) || '/'

/**
 * Markdown as it's drawn in a file's pane: frontmatter as the YAML it is, rather than run into a heading, and
 * `[[name]]`, how memory files point at each other, as a link to `name.md` beside it.
 */
function readable(text: string): string {
  const front = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text)
  const body = (front ? text.slice(front[0].length) : text).replace(/\[\[([^\]\n|/]+)\]\]/g, (_, name: string) => `[${name}](${encodeURI(name.trim())}.md)`)
  return front ? `\`\`\`yaml\n${front[1]}\n\`\`\`\n\n${body}` : body
}

/** How many columns text takes in monospace, its tabs taken to their stops. */
function columns(text: string): number {
  let col = 0
  for (const ch of text) col = ch === '\t' ? col + TAB - (col % TAB) : col + 1
  return col
}

/** A file's text, or why there's none to show. */
async function readText(path: string, machine: string): Promise<{ text: string } | { error: string }> {
  const res = await fetch(api.fileUrl(path, machine))
  if (!res.ok) return { error: (await res.json().then((b) => b.error, () => null)) ?? `${res.status} ${res.statusText}` }
  const bytes = new Uint8Array(await res.arrayBuffer())
  if (bytes.subarray(0, 8000).includes(0)) return { error: 'A binary file: there’s no text to show.' }
  return { text: new TextDecoder().decode(bytes) }
}

/** This file in the checkout's changes, if it's there, and its lines changed. */
function changesIn(diff: ReviewDiff | undefined, path: string) {
  const file = diff?.files.find((f) => `${diff.root}/${f.path}` === path)
  return { file, ...changedLines(file?.hunks ?? []) }
}

/**
 * A file beside its chat: all of it, with the lines changed since its base marked, or its diff (`renderDiff`, the
 * chat's diff page for that file alone). Which is shown is the view's, so a link can ask for either.
 */
export function FileView(props: {
  path: string
  line?: number
  /** Goes to `line` again each time it changes. */
  nav?: number
  mode: FileMode
  onMode: (mode: FileMode) => void
  machine: string
  /** Where git runs, for what's changed. */
  cwd?: string
  /** Read again when a turn ends, since that's when files change. */
  running: boolean
  onReady?: (focus: () => void) => void
  /** Adds lines picked out of it to the chat's message, as Markdown; absent when the chat can't take one. */
  onQuote?: (markdown: string) => void
  /** Opens another file, picked from its path's folders. */
  onOpen?: (path: string) => void
  /** The file's diff, `lead` first in its toolbar; `only` is its path in the checkout. */
  renderDiff: (only: string, lead: JSX.Element) => JSX.Element
}) {
  const [version, setVersion] = createSignal(0)
  const reload = () => setVersion((n) => n + 1)
  createEffect(on(() => props.running, (r) => !r && reload(), { defer: true }))
  const image = () => IMAGE.test(props.path)
  const markdown = () => MARKDOWN.test(props.path)
  /** Drawn as Markdown, rather than line by line. */
  const rendered = () => props.mode === 'rendered' && markdown()
  // Its links and images are from its folder, not the chat's.
  const outer = useOpenFile()
  const links = {
    cwd: () => dirOf(props.path),
    open: (path: string, line?: number) => (outer ? outer.open(path, line) : props.onOpen?.(path)),
  }
  const imageUrl = (src: string) => {
    const to = fileLink(src, dirOf(props.path))
    return to && api.fileUrl(to.path, props.machine)
  }

  const [content] = createResource(
    () => !image() && { path: props.path, machine: props.machine, v: version() },
    ({ path, machine }) => readText(path, machine).catch((e: Error) => ({ error: e.message })),
  )
  const [changes] = createResource(
    () => (props.cwd ? { cwd: props.cwd, machine: props.machine, v: version() } : false),
    ({ cwd, machine }): Promise<ReviewDiff | { error: string }> => api.review(cwd, 'base', 0, machine).catch((e: Error) => ({ error: e.message })),
  )
  const diff = () => {
    const c = changes()
    return c && 'files' in c ? c : undefined
  }
  const changed = createMemo(() => changesIn(diff(), props.path))
  const relative = () => {
    const root = diff()?.root
    return root && props.path.startsWith(`${root}/`) ? props.path.slice(root.length + 1) : undefined
  }
  /** Why its Diff can't be shown: there's no checkout, its changes couldn't be read, or the file is outside it. */
  const noDiff = () => {
    if (!props.cwd) return 'There’s no checkout to diff this file against.'
    const c = changes()
    if (changes.loading && !c) return 'Reading the changes…'
    return c && 'error' in c ? `Couldn’t read the changes: ${c.error}` : 'This file isn’t in the checkout, so it has no diff.'
  }

  const text = () => {
    const c = content()
    return c && 'text' in c ? c.text : undefined
  }
  const lines = createMemo(() => {
    const t = text()
    if (t === undefined) return []
    const all = t.split('\n')
    if (all.length > 1 && all[all.length - 1] === '') all.pop()
    return all
  })
  /** The lines drawn: all of them, or the start of a file too long to draw. */
  const shown = createMemo(() => (lines().length > MAX_LINES ? lines().slice(0, MAX_LINES) : lines()))
  const [colours] = createResource(
    () => text() !== undefined && { text: text()!, lang: languageOf(props.path) },
    async ({ text, lang }) => {
      const out = await highlight(text.replace(/\n$/, ''), lang)
      const split = out?.split('<br>')
      return { text, lines: split && split.length === lines().length ? split : undefined }
    },
  )
  /** Each line highlighted, only for the text as it is now: while a new read is highlighted, it's plain, not the last one's. */
  const html = () => {
    const c = colours()
    return c && c.text === text() ? c.lines : undefined
  }
  /**
   * The longest line drawn, in characters with its tabs taken to their stops: the lines' width before any is laid out,
   * since blocks off screen skip layout and so add no width of their own.
   */
  const widest = createMemo(() => {
    let most = 0
    for (const line of shown()) most = Math.max(most, columns(line))
    return most
  })
  const codeClass = () => `pr-4 pl-2 text-fg ${wrap() ? 'min-w-0 flex-1 whitespace-pre-wrap break-words' : 'whitespace-pre'}`
  /**
   * Wrapped, a line's later rows start under its code, a step in from where it starts, so they read as part of it
   * rather than lines of their own: its padding takes in its indent and the step, and its first row is pulled back.
   * Tab stops are counted from the padding, not from where the first row starts, so a line with a tab in it hangs by
   * whole stops, or its tabs would land short.
   */
  const codeStyle = (text: string): JSX.CSSProperties | undefined => {
    if (!wrap()) return undefined
    let hang = columns(text.match(/^[\t ]*/)![0]) + HANG
    if (text.includes('\t')) hang = Math.ceil(hang / TAB) * TAB
    return { 'padding-left': `calc(0.5rem + ${hang}ch)`, 'text-indent': `-${hang}ch` }
  }
  const blocks = createMemo(() => {
    const out: number[] = []
    for (let i = 0; i < shown().length; i += BLOCK) out.push(i)
    return out
  })

  let scroller: HTMLDivElement | undefined
  let linesEl: HTMLDivElement | undefined
  // Comments on its lines, kept with the chat's others, each under the last line it's on.
  const kept = useComments()
  type OnFile = DraftComment & { on: Extract<CommentAnchor, { kind: 'file' }> }
  const isMine = (c: { on: CommentAnchor }): c is OnFile => c.on.kind === 'file' && c.on.path === props.path
  // Questions asked about its lines show with them too.
  const mine = createMemo(() => ([...(kept?.all() ?? []), ...(kept?.asked() ?? [])] as DraftComment[]).filter(isMine))
  const writing = () => {
    const d = kept?.draft()
    return d && isMine(d) ? d : undefined
  }
  const commentsAt = createMemo(() => {
    const at = new Map<number, OnFile[]>()
    for (const c of mine()) at.set(c.on.to, [...(at.get(c.on.to) ?? []), c])
    return at
  })
  /** The lines comments are on, the one being written's too, tinted. */
  const commented = createMemo(() => {
    const out = new Set<number>()
    const w = writing()
    for (const { on } of [...mine(), ...(w ? [w] : [])]) if (on.kind === 'file') for (let n = on.from; n <= on.to; n++) out.add(n)
    return out
  })
  const draftBox = (d: CommentDraft) => (
    <DraftBox
      text={kept!.draftText()}
      editing={!!d.id}
      placeholder={d.on.kind === 'file' && d.on.to > d.on.from ? `On these ${d.on.to - d.on.from + 1} lines…` : 'On this line…'}
      onText={kept!.setDraftText}
      onComment={kept!.commit}
      onCancel={() => kept!.setDraft(undefined)}
      onAsk={d.id ? undefined : () => kept!.ask(d, kept!.draftText())}
      canAsk={kept!.canAsk()}
    />
  )
  /** The lines picked out of the file, whole, whatever part of the first and last line was selected. */
  const picked = (range: Range) => {
    const lineOf = (n: Node) => Number((n instanceof Element ? n : n.parentElement)?.closest<HTMLElement>('[data-line]')?.dataset.line)
    /** Whether any of line n's code is selected, rather than only where it starts or ends. */
    const takes = (n: number) => {
      const code = linesEl?.querySelector(`[data-line="${n}"]`)?.lastElementChild
      if (!code || !range.intersectsNode(code)) return false
      const part = document.createRange()
      part.selectNodeContents(code)
      if (range.compareBoundaryPoints(Range.START_TO_START, part) > 0) part.setStart(range.startContainer, range.startOffset)
      if (range.compareBoundaryPoints(Range.END_TO_END, part) < 0) part.setEnd(range.endContainer, range.endOffset)
      return part.toString() !== ''
    }
    let from = lineOf(range.startContainer) || 1
    let to = lineOf(range.endContainer) || shown().length
    // A drag can start after one line's end or stop at the next one's start without taking any of either.
    if (from < to && !takes(from)) from++
    if (to > from && !takes(to)) to--
    return { from, to, code: lines().slice(from - 1, to).join('\n') }
  }
  /** Lines picked out of the file as a fenced block under where they're from, e.g. `src/a.ts:12-15`: what Claude needs to find them. */
  const quoted = (range: Range) => {
    const { from, to, code } = picked(range)
    const fence = code.includes('```') ? '````' : '```'
    return `\`${relative() ?? props.path}:${from}${to > from ? `-${to}` : ''}\`\n${fence}${languageOf(props.path) ?? ''}\n${code}\n${fence}`
  }
  onMount(() => props.onReady?.(() => scroller?.focus({ preventScroll: true })))
  const [lit, setLit] = createSignal<number>()
  // So going to a line changes the two rows lit and unlit, not every row.
  const isLit = createSelector(lit)
  /** To the line asked for, once its block is drawn; it stays lit for a moment, so the eye finds it. */
  const goTo = (n: number) => {
    const el = scroller?.querySelector<HTMLElement>(`[data-line="${n}"]`)
    if (!el) return
    el.scrollIntoView({ block: 'center' })
    setLit(n)
    setTimeout(() => lit() === n && setLit(undefined), 1600)
  }
  // Once each time it's asked to, when the lines are there: not again when they're read again after a turn, which
  // would take the reader away from wherever they'd got to. Coming back from its Diff, the file is drawn afresh.
  let gone = ''
  createEffect(on(() => props.mode, () => (gone = '')))
  createEffect(
    on([() => props.nav, () => props.line, () => lines().length > 0, () => props.mode], ([nav, line, ready, mode]) => {
      const asked = `${nav}:${line}`
      if (mode !== 'file' || !line || !ready || asked === gone) return
      gone = asked
      requestAnimationFrame(() => goTo(line))
    }),
  )

  const toggle = () => (
    <Segmented
      value={props.mode}
      onChange={props.onMode}
      options={[
        ...(markdown() ? [{ value: 'rendered' as const, label: 'Rendered', title: 'As it reads, its Markdown drawn' }] : []),
        { value: 'file', label: markdown() ? 'Source' : 'File', title: 'As it is now, its changes marked in the margin' },
        { value: 'diff', label: 'Diff', title: 'All of it with its changes in place: lines taken out and put in' },
      ]}
    />
  )

  const crumbs = (after?: JSX.Element) => (
    <Breadcrumbs path={props.path} root={diff()?.root} machine={props.machine} onOpen={props.onOpen} after={after} />
  )

  return (
    <Show
      when={props.mode !== 'diff'}
      fallback={
        <Show
          when={relative()}
          fallback={
            // Its bar stays, so the other views are still a click away.
            <div class="flex min-h-0 flex-1 flex-col text-ui">
              <PaneBar class="whitespace-nowrap text-fg-3">
                {toggle()}
                {crumbs()}
              </PaneBar>
              <p class="p-6 text-center text-fg-3">{noDiff()}</p>
            </div>
          }
        >
          {(only) =>
            props.renderDiff(
              only(),
              <>
                {toggle()}
                {crumbs()}
              </>,
            )
          }
        </Show>
      }
    >
      <div class="flex min-h-0 flex-1 flex-col text-ui">
        <PaneBar class="whitespace-nowrap text-fg-3">
          {toggle()}
          {crumbs(<Show when={changed().file}>{(f) => <DiffCount files={1} added={f().added} removed={f().removed} class="shrink-0" />}</Show>)}
          <Show when={!image() && !rendered()}>
            <GhostButton title={wrap() ? 'Don’t wrap long lines' : 'Wrap long lines'} active={wrap()} aria-pressed={wrap()} onClick={toggleWrap}>
              <TextWrap class="size-3.5" />
            </GhostButton>
          </Show>
          <GhostButton title="Read it again" onClick={reload} class="-mr-1.5">
            <RotateCw class={`size-3.5 ${content.loading ? 'animate-spin' : ''}`} />
          </GhostButton>
        </PaneBar>
        <div ref={scroller} tabIndex={-1} class="min-h-0 flex-1 overflow-auto outline-none">
          <Show when={image()}>
            <div class="grid min-h-full place-items-center p-4">
              <img src={api.fileUrl(props.path, props.machine)} alt={props.path} class="max-w-full" />
            </div>
          </Show>
          <Show when={content()}>
            {(c) => (
              <Show when={'text' in c()} fallback={<p class="p-6 text-center text-fg-3">{(c() as { error: string }).error}</p>}>
                <Show when={rendered()}>
                  <OpenFile.Provider value={links}>
                    <div class="mx-auto max-w-3xl px-6 py-5">
                      <Markdown text={readable(text()!)} image={imageUrl} />
                    </div>
                  </OpenFile.Provider>
                </Show>
                <Show when={!rendered()}>
                  <div ref={linesEl} data-comments-on={kept && `file:${props.path}`} class={`relative py-1 font-mono text-xs leading-5 ${wrap() ? '' : 'min-w-max'}`}>
                    {/* The number's room and the line's padding (see CodeRow) beside the longest line, as a guess at its
                        width; lines drawn wider than their characters, as CJK and emoji are, widen it past that. */}
                    <Show when={!wrap()}>
                      <div style={{ width: `calc(${widest() + Math.max(4, String(shown().length).length)}ch + 2.25rem)` }} />
                    </Show>
                    <Show when={props.onQuote || kept}>
                      <QuoteSelection
                        within={() => linesEl}
                        onQuote={props.onQuote && ((_, range) => props.onQuote?.(quoted(range)))}
                        onComment={
                          kept &&
                          ((_, __, range) => {
                            const { from, to, code } = picked(range)
                            kept.setDraft({ on: { kind: 'file', path: props.path, from, to }, quote: code })
                          })
                        }
                      />
                    </Show>
                    <For each={blocks()}>
                      {(start) => (
                        // Its height guessed until it's drawn, but no width: one length alone would be taken for both, and
                        // a block off screen would claim to be thousands of pixels wide.
                        <div style={{ 'content-visibility': 'auto', 'contain-intrinsic-size': `auto 0px auto ${Math.min(BLOCK, shown().length - start) * 20}px` }}>
                          {/* By place, not by text: read again with a line put in above, each row keeps its number and takes the new text. */}
                          <Index each={shown().slice(start, start + BLOCK)}>
                            {(text, i) => {
                              const n = start + i + 1
                              const added = () => changed().added.has(n)
                              const removed = () => changed().removed.get(n)
                              return (
                                <>
                                <CodeRow
                                  data-line={n}
                                  number={n}
                                  digits={String(shown().length).length}
                                  lit={isLit(n)}
                                  class={commented().has(n) ? 'bg-accent/10' : ''}
                                  // Changes only marked in the margin, so the file reads as the file: a green edge by a
                                  // line added, a small red notch where lines were taken out. Its Diff shows them.
                                  gutter={{
                                    class: `relative border-l-2 ${added() ? 'border-ok/70' : 'border-transparent'} ${
                                      removed() ? "before:absolute before:-top-1 before:-left-0.5 before:border-y-4 before:border-l-4 before:border-y-transparent before:border-l-danger/80 before:content-['']" : ''
                                    }`,
                                    title: added() ? 'Added' : removed() ? `${plural(removed()!, 'line')} taken out above this one` : undefined,
                                  }}
                                >
                                  <Show when={html()?.[n - 1]} fallback={<span class={codeClass()} style={codeStyle(text())}>{text()}</span>}>
                                    {(h) => <span class={codeClass()} style={codeStyle(text())} innerHTML={h()} />}
                                  </Show>
                                </CodeRow>
                                {/* Comments on lines ending here, and the one being written, under them. */}
                                <Show when={commentsAt().has(n) || writing()?.on.to === n}>
                                  <div class="comment-host px-3 font-sans whitespace-normal">
                                    <For each={commentsAt().get(n)}>
                                      {(c) =>
                                        'chat' in c ? (
                                          <AskedItem asked={c as Asked} />
                                        ) : (
                                          <Show when={writing()?.id === c.id ? writing() : undefined} fallback={<CommentBox text={c.text} onEdit={() => kept!.setDraft({ ...c })} onRemove={() => kept!.remove(c.id)} />}>
                                            {(d) => draftBox(d())}
                                          </Show>
                                        )
                                      }
                                    </For>
                                    <Show when={writing()?.on.to === n && !writing()!.id ? writing() : undefined}>{(d) => draftBox(d())}</Show>
                                  </div>
                                </Show>
                                </>
                              )
                            }}
                          </Index>
                        </div>
                      )}
                    </For>
                    <Show when={lines().length > shown().length}>
                      <p class="px-4 py-3 font-sans text-fg-3">
                        Only the first {MAX_LINES.toLocaleString()} of its {lines().length.toLocaleString()} lines are shown here.
                      </p>
                    </Show>
                  </div>
                </Show>
              </Show>
            )}
          </Show>
        </div>
      </div>
    </Show>
  )
}
