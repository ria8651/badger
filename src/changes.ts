import { createEffect, createMemo, createSignal, on, onCleanup, type Accessor, type Setter } from 'solid-js'
import type { ReviewDiff } from '../shared/protocol.ts'
import { api } from './api.ts'
import { baseChanged } from './components/BasePicker.tsx'

/*
 * A checkout's changes against its base, read once for everything showing them: the files' tree, the chat's diff, a
 * file's diff and the file itself. So they agree, and one read serves them all. Three lines of context, as the chat's
 * diff shows them: its hunks are what's ticked off as viewed, wherever that's done.
 *
 * Kept up to date by asking, every few seconds while anything shows them and the tab's in view, for a stamp of what
 * they're made of (changesStamp on the server), and reading them again only when it's changed. So an edit made in a
 * terminal shows too, not only Claude's, and nothing's read while nothing changes. Also asked when a turn ends, a base
 * is picked, something starts showing them, or the tab comes back into view.
 */

/** How often the stamp's asked for while the changes are on screen. */
const POLL_MS = 3000

interface Entry {
  cwd: string
  machine: string
  diff: [Accessor<ReviewDiff | undefined>, Setter<ReviewDiff | undefined>]
  error: [Accessor<string | undefined>, Setter<string | undefined>]
  loading: [Accessor<boolean>, Setter<boolean>]
  /** The stamp of what was read last. */
  stamp?: string
  /** A check is asked for in this moment: however many ask, it's one. */
  queued: boolean
  checking: boolean
  /** Asked for again while a check was out: once that's back, check again, as it may be from before what was asked about. */
  again: boolean
  /** How many views show it: with none, it's let go. */
  users: number
}

const entries = new Map<string, Entry>()
const keyOf = (cwd: string, machine: string) => `${machine}\0${cwd}`

/** Asks for the stamp, and reads the changes again if it's not what was read. */
async function check(e: Entry) {
  if (e.checking) {
    e.again = true
    return
  }
  e.checking = true
  try {
    // With no stamp to be had (no git there, say), the read says why.
    const stamp = await api.changesStamp(e.cwd, e.machine).then(
      (r) => r.stamp,
      () => undefined,
    )
    if (stamp && stamp === e.stamp && e.diff[0]()) return
    e.loading[1](true)
    try {
      const d = await api.review(e.cwd, 'base', 3, e.machine)
      e.stamp = stamp
      e.diff[1](d)
      e.error[1](undefined)
    } catch (err) {
      e.error[1]((err as Error).message)
    } finally {
      e.loading[1](false)
    }
  } finally {
    e.checking = false
    if (e.again) {
      e.again = false
      void check(e)
    }
  }
}

function queue(e: Entry) {
  if (e.queued) return
  e.queued = true
  queueMicrotask(() => {
    e.queued = false
    void check(e)
  })
}

// While the tab's in view, whatever's showing changes is checked on; coming back into view, at once.
setInterval(() => document.visibilityState === 'visible' && entries.forEach(queue), POLL_MS)
document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && entries.forEach(queue))

/**
 * The changes in `cwd`'s checkout, kept up to date while shown: a new diff only when they've changed, so anything
 * read along with them can go by it. What was read before shows meanwhile.
 */
export function useChanges(where: () => { cwd?: string; machine: string }, running: () => boolean) {
  const at = createMemo(() => {
    const { cwd, machine } = where()
    if (!cwd) return
    const key = keyOf(cwd, machine)
    let e = entries.get(key)
    if (!e) {
      e = { cwd, machine, diff: createSignal(), error: createSignal(), loading: createSignal(false), queued: false, checking: false, again: false, users: 0 }
      entries.set(key, e)
    }
    return e
  })
  // Counted while shown, and let go with the last view of it, rather than kept for good.
  createEffect(
    on(at, (e) => {
      if (!e) return
      e.users++
      queue(e)
      onCleanup(() => {
        if (--e.users === 0) entries.delete(keyOf(e.cwd, e.machine))
      })
    }),
  )
  const reload = () => {
    const e = at()
    if (e) queue(e)
  }
  createEffect(on(running, (r) => !r && reload(), { defer: true }))
  createEffect(on(baseChanged, reload, { defer: true }))
  return {
    diff: () => at()?.diff[0](),
    error: () => at()?.error[0](),
    loading: () => !!at()?.loading[0](),
    reload,
  }
}
