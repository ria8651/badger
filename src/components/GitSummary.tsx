import { createEffect, createSignal, For, onCleanup, onMount, Show, type Component } from 'solid-js'
import { ArrowDown, ArrowDownToLine, ArrowUp, CloudOff, GitBranch, GitMerge } from '../icons'
import type { GitStatus } from '../../shared/protocol.ts'
import { DiffCount } from './ui.tsx'

export interface GitPart {
  text: string
  count?: number
  icon: Component<{ class?: string }>
  tone: string
  /** What it means, in full. */
  title: string
}

/** What isn't in step, each with its icon, for the summary and anywhere that spells it out. */
export function gitParts(g: GitStatus, hide?: 'ahead' | 'behind'): GitPart[] {
  const out: GitPart[] = []
  if (g.ahead && hide !== 'ahead')
    out.push(
      g.upstream
        ? { text: `${g.ahead} ahead`, count: g.ahead, icon: ArrowUp, tone: 'text-fg-2', title: `Commits ${g.upstream} doesn't have` }
        : { text: `${g.ahead} not pushed`, count: g.ahead, icon: ArrowUp, tone: 'text-fg-2', title: g.remote ? `Commits no remote has; ${g.branch || 'HEAD'} isn't on ${g.remote} yet` : 'Commits no remote has' },
    )
  if (g.behind && hide !== 'behind') out.push({ text: `${g.behind} behind`, count: g.behind, icon: ArrowDown, tone: 'text-fg-2', title: `Commits on ${g.upstream} not here` })
  if (g.base?.ahead) out.push({ text: `${g.base.ahead} unmerged`, count: g.base.ahead, icon: GitMerge, tone: 'text-fg-2', title: `Commits ${g.base.branch} doesn't have` })
  if (g.base?.behind)
    out.push({ text: `${g.base.behind} behind ${g.base.branch}`, count: g.base.behind, icon: ArrowDownToLine, tone: 'text-fg-3', title: `Commits on ${g.base.branch} not here` })
  if (!g.upstream && !g.remote) out.push({ text: 'no remote', icon: CloudOff, tone: 'text-fg-3', title: 'This repo has no remote to push to' })
  return out
}

/**
 * How a checkout stands, the same wherever one is shown: its branch, what's
 * uncommitted, and then only what isn't in step. Nothing after the branch
 * means there's nothing to do. `hide` leaves out what a button beside it says.
 * Short of room for the words, each part shrinks to an icon and its number.
 */
export function GitSummary(props: { git: GitStatus; branch?: boolean; hide?: 'ahead' | 'behind'; class?: string }) {
  const parts = () => gitParts(props.git, props.hide)

  // Words while nothing is cut short by them. To see whether they'd fit again, they're put back and measured
  // before the page is drawn, so they never show cut off.
  let el!: HTMLSpanElement
  const [compact, setCompact] = createSignal(false)
  const cut = () => [el, ...el.querySelectorAll<HTMLElement>('.truncate')].some((e) => e.scrollWidth > e.clientWidth)
  const fit = () => {
    if (!el.isConnected) return
    setCompact(false)
    if (cut()) setCompact(true)
  }
  onMount(() => {
    const observer = new ResizeObserver(fit)
    observer.observe(el)
    // The room it's given, which can grow while it stays the size of its icons.
    observer.observe(el.closest('.\\@container') ?? document.documentElement)
    onCleanup(() => observer.disconnect())
  })
  createEffect(() => {
    parts()
    props.git.branch
    fit()
  })

  return (
    <span ref={el} class={`flex min-w-0 items-center gap-2 whitespace-nowrap ${props.class ?? ''}`}>
      <Show when={props.branch}>
        {/* At the least, its icon: down to that, rather than spill over what's next to it. */}
        <span class="flex min-w-3.5 items-center gap-1 font-mono text-fg-2">
          <GitBranch class="size-3.5 shrink-0 text-fg-3" />
          <span class="truncate">{props.git.branch || 'detached'}</span>
        </span>
      </Show>
      <DiffCount files={props.git.changes} added={props.git.added} removed={props.git.removed} class="shrink-0" />
      <For each={parts()}>
        {(p) => (
          <Show
            when={compact()}
            fallback={
              <span class={`min-w-0 truncate ${p.tone}`} title={p.title}>
                {p.text}
              </span>
            }
          >
            <span class={`flex shrink-0 items-center gap-0.5 tabular-nums ${p.tone}`} title={`${p.text}: ${p.title}`}>
              <p.icon class="size-3.5" />
              {p.count}
            </span>
          </Show>
        )}
      </For>
    </span>
  )
}
