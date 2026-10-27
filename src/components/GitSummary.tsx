import { For, Show } from 'solid-js'
import { GitBranch } from '../icons'
import type { GitStatus } from '../../shared/protocol.ts'
import { DiffCount } from './ui.tsx'

/**
 * How a checkout stands, the same wherever one is shown: its branch, what's
 * uncommitted, and then only what isn't in step. Nothing after the branch
 * means there's nothing to do. `hide` leaves out what a button beside it says.
 */
export function GitSummary(props: {
  git: GitStatus
  branch?: boolean
  hide?: 'ahead' | 'behind'
  class?: string
  /** On each part after the counts, e.g. to drop them when there's no room. */
  partClass?: string
}) {
  const parts = () => {
    const g = props.git
    const out: { text: string; tone: string; title: string }[] = []
    if (g.ahead && props.hide !== 'ahead')
      out.push(
        g.upstream
          ? { text: `${g.ahead} ahead`, tone: 'text-fg-2', title: `Commits ${g.upstream} doesn't have` }
          : { text: `${g.ahead} not pushed`, tone: 'text-fg-2', title: `Commits no remote has; ${g.branch || 'HEAD'} isn't on ${g.remote} yet` },
      )
    if (g.behind && props.hide !== 'behind') out.push({ text: `${g.behind} behind`, tone: 'text-fg-2', title: `Commits on ${g.upstream} not here` })
    if (g.base?.ahead) out.push({ text: `${g.base.ahead} unmerged`, tone: 'text-fg-2', title: `Commits ${g.base.branch} doesn't have` })
    if (g.base?.behind) out.push({ text: `${g.base.behind} behind ${g.base.branch}`, tone: 'text-fg-3', title: `Commits on ${g.base.branch} not here` })
    if (!g.upstream && !g.remote) out.push({ text: 'no remote', tone: 'text-fg-3', title: 'This repo has no remote to push to' })
    return out
  }
  return (
    <span class={`flex min-w-0 items-center gap-2 whitespace-nowrap ${props.class ?? ''}`}>
      <Show when={props.branch}>
        <span class="flex min-w-0 items-center gap-1 font-mono text-fg-2">
          <GitBranch class="size-3.5 shrink-0 text-fg-3" />
          <span class="truncate">{props.git.branch || 'detached'}</span>
        </span>
      </Show>
      <DiffCount files={props.git.changes} added={props.git.added} removed={props.git.removed} class="shrink-0" />
      {/* Short of room, these truncate along with the branch rather than spill over what's next to them. */}
      <For each={parts()}>
        {(p) => (
          <span class={`min-w-0 truncate ${p.tone} ${props.partClass ?? ''}`} title={p.title}>
            {p.text}
          </span>
        )}
      </For>
    </span>
  )
}
