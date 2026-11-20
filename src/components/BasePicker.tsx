import { Show, createSignal, type JSX } from 'solid-js'
import { ChevronDown } from '../icons'
import type { BaseChoices, BaseHow } from '../../shared/protocol.ts'
import { api } from '../api.ts'
import { showError } from './Popover.tsx'
import { DiffCount, SearchMenu, type SearchItem } from './ui.tsx'

const [changes, setChanges] = createSignal(0)
/** Goes up whenever a base is picked anywhere, so whatever shows one reads it again. */
export const baseChanged = changes
/** For what changes the base other than picking one, like switching branch. */
export const touchBase = () => setChanges((n) => n + 1)

export const howText: Record<BaseHow, string> = {
  set: 'picked by hand',
  pr: "its pull request's base",
  nearest: 'the nearest likely base',
}

/**
 * Picks what a branch is compared with: the commits it has that the base doesn't, and the diff review's start.
 * Working it out is the default; picking one keeps it for the branch, in every checkout of it.
 */
export function BasePicker(props: {
  dir: string
  machine: string
  /** Or, opened from elsewhere, `anchor` and `opener` as SearchMenu takes them. */
  trigger?: (open: () => boolean) => JSX.Element
  triggerClass?: (open: boolean) => string
  anchor?: () => HTMLElement
  opener?: (show: () => void) => void
  title?: string
}) {
  const [choices, setChoices] = createSignal<BaseChoices>()
  const pick = (base: string | null) =>
    void api
      .setBase(props.dir, base, props.machine)
      .then(() => setChanges((n) => n + 1))
      .catch((e: Error) => showError("Couldn't change the base", e.message))

  const items = (q: string): SearchItem[] => {
    const c = choices()
    if (!c) return [{ label: 'Reading branches…', pick: () => {} }]
    if (!c.branch) return [{ label: 'No branch checked out', description: 'A detached HEAD has nowhere to keep a base.', pick: () => {} }]
    const needle = q.toLowerCase()
    const matches = (s: string) => !q || s.toLowerCase().includes(needle)
    const list: SearchItem[] = []
    if (!q) {
      const guessed = c.set === undefined && c.current
      list.push({
        label: 'Work it out',
        description: guessed ? `Now ${guessed.branch}, ${howText[guessed.how]}` : 'Its pull request’s base, else the nearest likely one',
        selected: c.set === undefined,
        pick: () => c.set !== undefined && pick(null),
      })
    }
    const up = c.upstream
    if (up && matches(up.branch))
      list.push({
        label: up.branch,
        description: 'Where it pushes to: only what isn’t pushed yet',
        hint: up.ahead ? `${up.ahead} to push` : 'all pushed',
        selected: c.set === up.branch,
        pick: () => pick(up.branch),
      })
    for (const b of c.likely.filter((b) => matches(b.branch) && b.branch !== up?.branch))
      list.push({ label: b.branch, hint: b.ahead ? `${b.ahead} ahead of it` : 'nothing ahead', selected: c.set === b.branch, pick: () => pick(b.branch) })
    // Every other branch only when looked for: there can be hundreds.
    if (q) for (const b of c.others.filter(matches).slice(0, 50)) list.push({ label: b, selected: c.set === b, pick: () => pick(b) })
    if (c.set && c.set !== up?.branch && !c.likely.some((b) => b.branch === c.set) && !list.some((i) => i.label === c.set))
      list.push({ label: c.set, selected: true, pick: () => {} })
    if (!q || matches('none')) list.push({ label: 'None', description: 'Compare with nothing: only uncommitted changes count', selected: c.set === '', pick: () => pick('') })
    return list
  }

  return (
    <SearchMenu
      items={items}
      placeholder="Find a branch"
      empty="No branch by that name"
      width={320}
      title={props.title}
      trigger={props.trigger}
      triggerClass={props.triggerClass}
      anchor={props.anchor}
      opener={props.opener}
      onOpenChange={(open) => {
        if (!open) return
        setChoices(undefined)
        api.baseChoices(props.dir, props.machine).then(setChoices, (e: Error) => showError("Couldn't read the branches", e.message))
      }}
    />
  )
}

/**
 * What a diff is against, to pick another by, and how much it adds and takes out: the same in every bar that shows
 * changes. Short of room, the counts go first (wrapped onto a line that's clipped, so they're never drawn over
 * anything), then the base's name shortens; the word "against" only shows in a wide pane.
 */
export function Against(props: { dir?: string; machine: string; base?: string; baseHow?: BaseHow; files: number; added: number; removed: number }) {
  return (
    <div class="-mx-1.5 flex h-6 min-w-0 flex-wrap content-start items-center gap-x-3 overflow-hidden px-1.5 whitespace-nowrap text-fg-3">
      <Show when={props.dir}>
        {(dir) => (
          <BasePicker
            dir={dir()}
            machine={props.machine}
            title={props.base ? `Compared with ${props.base}, ${howText[props.baseHow ?? 'nearest']}. Pick another` : 'Pick a branch to compare with'}
            triggerClass={(open) => `-mx-1.5 flex h-6 min-w-0 items-center gap-1 rounded-md px-1.5 transition-colors hover:bg-surface ${open ? 'bg-surface' : ''}`}
            trigger={() => (
              <>
                <Show when={props.base} fallback="Uncommitted only">
                  <span class="hidden @md:inline">against </span>
                  <span class="min-w-0 truncate font-mono text-fg-2">{props.base}</span>
                </Show>
                <ChevronDown class="size-3 shrink-0" />
              </>
            )}
          />
        )}
      </Show>
      <DiffCount files={props.files} added={props.added} removed={props.removed} class="h-6 shrink-0" />
    </div>
  )
}
