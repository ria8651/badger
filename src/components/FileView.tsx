import { For, Index, Show, createEffect, createMemo, createResource, createSelector, createSignal, on, onMount, type JSX } from 'solid-js'
import { RotateCw } from '../icons'
import type { ReviewDiff } from '../../shared/protocol.ts'
import { api } from '../api.ts'
import { changedLines } from '../diffRows.ts'
import { plural } from '../format.ts'
import { highlight, languageOf } from '../highlight.ts'
import { CodeRow } from './CodeRow.tsx'
import { QuoteSelection } from './QuoteSelection.tsx'
import { DiffCount, GhostButton, PaneBar, PathLabel, Segmented } from './ui.tsx'

/** Lines drawn per block; blocks off screen skip layout, so a long file costs little until it's scrolled through. */
const BLOCK = 200
/** Past this many lines, a file shows its start: drawing every line of a big log would hang the tab. */
const MAX_LINES = 20_000
/** The images the server sends as images; anything else, an SVG say, comes as text. */
const IMAGE = /\.(png|jpe?g|gif|webp)$/i

export type FileMode = 'file' | 'diff'

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
  /** The file's diff, `lead` first in its toolbar; `only` is its path in the checkout. */
  renderDiff: (only: string, lead: JSX.Element) => JSX.Element
}) {
  const [version, setVersion] = createSignal(0)
  const reload = () => setVersion((n) => n + 1)
  createEffect(on(() => props.running, (r) => !r && reload(), { defer: true }))
  const image = () => IMAGE.test(props.path)

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
  /** Why its Diff can't be shown: the changes couldn't be read, or it isn't in them. */
  const noDiff = () => {
    const c = changes()
    if (changes.loading && !c) return 'Reading the changes…'
    return c && 'error' in c ? `Couldn’t read the changes: ${c.error}` : 'This file isn’t in the checkout’s changes.'
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
  const blocks = createMemo(() => {
    const out: number[] = []
    for (let i = 0; i < shown().length; i += BLOCK) out.push(i)
    return out
  })

  let scroller: HTMLDivElement | undefined
  let linesEl: HTMLDivElement | undefined
  /**
   * Lines picked out of the file, whole, as a fenced block under where they're from, e.g. `src/a.ts:12-15`: what Claude
   * needs to find them, whatever part of the first and last line was selected.
   */
  const quoted = (range: Range) => {
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
    const code = lines().slice(from - 1, to).join('\n')
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
        { value: 'file', label: 'File', title: 'As it is now, its changes marked in the margin' },
        { value: 'diff', label: 'Diff', title: 'All of it with its changes in place: lines taken out and put in' },
      ]}
    />
  )

  return (
    <Show
      when={props.mode === 'file'}
      fallback={
        <Show when={relative()} fallback={<p class="p-6 text-center text-ui text-fg-3">{noDiff()}</p>}>
          {(only) =>
            props.renderDiff(
              only(),
              <>
                {toggle()}
                <PathLabel path={only()} class="text-fg-3" />
              </>,
            )
          }
        </Show>
      }
    >
      <div class="flex min-h-0 flex-1 flex-col text-ui">
        <PaneBar class="whitespace-nowrap text-fg-3">
          {toggle()}
          <PathLabel path={relative() ?? props.path} />
          <Show when={changed().file}>{(f) => <DiffCount files={1} added={f().added} removed={f().removed} class="shrink-0" />}</Show>
          <div class="flex-1" />
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
                <div ref={linesEl} class="relative min-w-max py-1 font-mono text-xs leading-5">
                  <Show when={props.onQuote}>{(q) => <QuoteSelection within={() => linesEl} onQuote={(_, range) => q()(quoted(range))} />}</Show>
                  <For each={blocks()}>
                    {(start) => (
                      <div style={{ 'content-visibility': 'auto', 'contain-intrinsic-size': `auto ${Math.min(BLOCK, shown().length - start) * 20}px` }}>
                        {/* By place, not by text: read again with a line put in above, each row keeps its number and takes the new text. */}
                        <Index each={shown().slice(start, start + BLOCK)}>
                          {(text, i) => {
                            const n = start + i + 1
                            const added = () => changed().added.has(n)
                            const removed = () => changed().removed.get(n)
                            return (
                              <CodeRow
                                data-line={n}
                                numbers={[n]}
                                lit={isLit(n)}
                                // Changes only marked in the margin, so the file reads as the file: a green edge by a
                                // line added, a small red notch where lines were taken out. Its Diff shows them.
                                gutter={{
                                  class: `relative border-l-2 ${added() ? 'border-ok/70' : 'border-transparent'} ${
                                    removed() ? "before:absolute before:-top-1 before:-left-0.5 before:border-y-4 before:border-l-4 before:border-y-transparent before:border-l-danger/80 before:content-['']" : ''
                                  }`,
                                  title: added() ? 'Added' : removed() ? `${plural(removed()!, 'line')} taken out above this one` : undefined,
                                }}
                              >
                                <Show when={html()?.[n - 1]} fallback={<span class="whitespace-pre pr-4 pl-2 text-fg">{text()}</span>}>
                                  {(h) => <span class="whitespace-pre pr-4 pl-2 text-fg" innerHTML={h()} />}
                                </Show>
                              </CodeRow>
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
            )}
          </Show>
        </div>
      </div>
    </Show>
  )
}
