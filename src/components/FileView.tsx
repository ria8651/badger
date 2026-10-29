import { For, Show, createEffect, createMemo, createResource, createSignal, on, onMount, type JSX } from 'solid-js'
import { RotateCw } from '../icons'
import type { ReviewDiff } from '../../shared/protocol.ts'
import { api } from '../api.ts'
import { highlight, languageOf } from '../highlight.ts'
import { DiffCount, GhostButton } from './ui.tsx'

/** Lines drawn per block; blocks off screen skip layout, so a long file costs little until it's scrolled through. */
const BLOCK = 200
const IMAGE = /\.(png|jpe?g|gif|webp|svg|avif|bmp|ico)$/i

export type FileMode = 'file' | 'diff'

/** A file's text, or why there's none to show. */
async function readText(path: string, machine: string): Promise<{ text: string } | { error: string }> {
  const res = await fetch(api.fileUrl(path, machine))
  if (!res.ok) return { error: (await res.json().then((b) => b.error, () => null)) ?? `${res.status} ${res.statusText}` }
  const bytes = new Uint8Array(await res.arrayBuffer())
  if (bytes.subarray(0, 8000).includes(0)) return { error: 'A binary file: there’s no text to show.' }
  return { text: new TextDecoder().decode(bytes) }
}

/** The lines added, by their number in the file now, and where lines were taken out, by the line they were before. */
function changesIn(diff: ReviewDiff | undefined, path: string) {
  const added = new Set<number>()
  const removed = new Map<number, number>()
  const file = diff?.files.find((f) => `${diff.root}/${f.path}` === path)
  for (const h of file?.hunks ?? []) {
    let line = 0
    for (const l of h.patch.split('\n')) {
      const at = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(l)
      if (at) line = Number(at[1])
      else if (l.startsWith('+')) added.add(line++)
      else if (l.startsWith('-')) removed.set(line, (removed.get(line) ?? 0) + 1)
      else if (l.startsWith(' ')) line++
    }
  }
  return { file, added, removed }
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
    ({ cwd, machine }) => api.review(cwd, 'base', 0, machine).catch(() => undefined),
  )
  const changed = createMemo(() => changesIn(changes(), props.path))
  const relative = () => {
    const root = changes()?.root
    return root && props.path.startsWith(`${root}/`) ? props.path.slice(root.length + 1) : undefined
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
  const [html] = createResource(
    () => text() !== undefined && { text: text()!, lang: languageOf(props.path) },
    async ({ text, lang }) => {
      const out = await highlight(text.replace(/\n$/, ''), lang)
      const split = out?.split('<br>')
      return split && split.length === lines().length ? split : undefined
    },
  )
  const blocks = createMemo(() => {
    const out: number[] = []
    for (let i = 0; i < lines().length; i += BLOCK) out.push(i)
    return out
  })

  let scroller: HTMLDivElement | undefined
  onMount(() => props.onReady?.(() => scroller?.focus({ preventScroll: true })))
  const [lit, setLit] = createSignal<number>()
  /** To the line asked for, once its block is drawn; it stays lit for a moment, so the eye finds it. */
  const goTo = (n: number) => {
    const el = scroller?.querySelector<HTMLElement>(`[data-line="${n}"]`)
    if (!el) return
    el.scrollIntoView({ block: 'center' })
    setLit(n)
    setTimeout(() => lit() === n && setLit(undefined), 1600)
  }
  createEffect(
    on([() => props.nav, () => props.line, () => lines().length, () => props.mode], ([, line, count, mode]) => {
      if (mode === 'file' && line && count) requestAnimationFrame(() => goTo(line))
    }),
  )

  const toggle = () => (
    <div class="flex shrink-0 items-center rounded-md bg-surface p-0.5 text-xs">
      <For each={['file', 'diff'] as const}>
        {(m) => (
          <button
            onClick={() => props.onMode(m)}
            class={`rounded px-1.5 py-0.5 ${props.mode === m ? 'bg-bg text-fg shadow-(--shadow-control)' : 'text-fg-3 hover:text-fg-2'}`}
          >
            {m === 'file' ? 'File' : 'Diff'}
          </button>
        )}
      </For>
    </div>
  )
  const tools = () => (
    <div class="flex min-w-0 flex-1 items-center gap-3 text-xs whitespace-nowrap text-fg-3">
      {toggle()}
      <span class="min-w-0 truncate font-mono" dir="rtl" title={props.path}>
        <bdi>{relative() ?? props.path}</bdi>
      </span>
      <Show when={changed().file}>{(f) => <DiffCount files={1} added={f().added} removed={f().removed} class="shrink-0" />}</Show>
      <div class="flex-1" />
      <div class="-mr-1.5 flex shrink-0 items-center">
        <GhostButton title="Read it again" onClick={reload}>
          <RotateCw class={`size-3.5 ${content.loading ? 'animate-spin' : ''}`} />
        </GhostButton>
      </div>
    </div>
  )

  return (
    <Show
      when={props.mode === 'file'}
      fallback={
        <Show when={relative()} fallback={<p class="p-6 text-center text-ui text-fg-3">{changes.loading ? 'Reading the changes…' : 'This file isn’t in the checkout’s changes.'}</p>}>
          {(only) => props.renderDiff(only(), toggle())}
        </Show>
      }
    >
      <div class="flex min-h-0 flex-1 flex-col text-ui">
        <div class="flex h-9 shrink-0 items-center border-b border-line px-3">{tools()}</div>
        <div ref={scroller} tabIndex={-1} class="min-h-0 flex-1 overflow-auto outline-none">
          <Show when={image()}>
            <div class="grid min-h-full place-items-center p-4">
              <img src={api.fileUrl(props.path, props.machine)} alt={props.path} class="max-w-full" />
            </div>
          </Show>
          <Show when={content()}>
            {(c) => (
              <Show when={'text' in c()} fallback={<p class="p-6 text-center text-fg-3">{(c() as { error: string }).error}</p>}>
                <div class="min-w-max py-1 font-mono text-xs leading-5">
                  <For each={blocks()}>
                    {(start) => (
                      <div style={{ 'content-visibility': 'auto', 'contain-intrinsic-size': `auto ${Math.min(BLOCK, lines().length - start) * 20}px` }}>
                        <For each={lines().slice(start, start + BLOCK)}>
                          {(text, i) => {
                            const n = start + i() + 1
                            const added = () => changed().added.has(n)
                            const removed = () => changed().removed.get(n)
                            return (
                              <div data-line={n} class={`flex transition-colors ${lit() === n ? 'bg-accent/20' : added() ? 'bg-ok/10' : ''}`}>
                                <span
                                  class={`w-12 shrink-0 select-none border-l-2 pr-3 text-right tabular-nums ${
                                    added() ? 'border-ok text-fg-3' : 'border-transparent text-fg-3/70'
                                  } ${removed() ? 'shadow-[inset_0_2px_0_var(--color-danger)]' : ''}`}
                                  title={removed() ? `${removed()} line${removed() === 1 ? '' : 's'} taken out above this one` : undefined}
                                >
                                  {n}
                                </span>
                                <Show when={html()?.[n - 1]} fallback={<span class="whitespace-pre pr-4 text-fg">{text}</span>}>
                                  {(h) => <span class="whitespace-pre pr-4 text-fg" innerHTML={h()} />}
                                </Show>
                              </div>
                            )
                          }}
                        </For>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
            )}
          </Show>
        </div>
      </div>
    </Show>
  )
}
