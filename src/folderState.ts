import { createSignal, type Accessor, type Setter } from 'solid-js'
import type { GitStatus, WorktreeStatus } from '../shared/protocol.ts'

/*
 * What was last read about each folder, by machine and path: shown straight away wherever the folder shows next,
 * and marked as updating while it's read again. So the new chat screen, a chat's header and a card's worktrees agree,
 * and none of them start blank for a folder another has already read. Kept for as long as the page is open.
 */

function keyed<T>() {
  const entries = new Map<string, [Accessor<T | undefined>, Setter<T | undefined>]>()
  const entry = (machine: string, path: string) => {
    const k = `${machine}\0${path}`
    let e = entries.get(k)
    if (!e) entries.set(k, (e = createSignal<T>()))
    return e
  }
  return {
    /** Undefined until it's first read. */
    get: (machine: string, path: string) => entry(machine, path)[0](),
    set: (machine: string, path: string, value: T) => void entry(machine, path)[1](() => value),
  }
}

/** A checkout's git status; null outside a repo. */
export const gitState = keyed<GitStatus | null>()
/** Space on disk, in bytes. */
export const sizeState = keyed<number>()
/** A worktree's branch and what's not merged yet. */
export const worktreeState = keyed<WorktreeStatus>()

/** How a value that's shown while it's read again looks. */
export const UPDATING = 'animate-pulse'
