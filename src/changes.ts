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
  /** Read at least once, whether that worked or not. */
  read: boolean
  /** The stamp when it was last read: none if there was none to be had, e.g. outside git. */
  stamp?: string
  /** A check is asked for in this moment: however many ask, it's one. `force` if any of them wants a read whatever the stamp. */
  queued?: { force: boolean }
  checking: boolean
  /** Asked for again while a check was out: once that's back, check again, as it may be from before what was asked about. */
  again?: { force: boolean }
  /** How many views show it: with none, it's let go. */
  users: number
}

const entries = new Map<string, Entry>()

function entryFor(cwd: string, machine: string): Entry {
  const key = keyOf(cwd, machine)
  let e = entries.get(key)
  if (!e) {
    e = { cwd, machine, diff: createSignal(), error: createSignal(), loading: createSignal(false), read: false, checking: false, users: 0 }
    entries.set(key, e)
  }
  return e
}
const keyOf = (cwd: string, machine: string) => `${machine}\0${cwd}`

/**
 * Asks for the stamp, and reads the changes again if it's not what was read, or if `force`d. A read that failed isn't
 * tried again until the stamp changes or something asks for it, so changes too big to show, say, aren't read every poll;
 * nor is anything with no stamp to be had (no git there), which only reads when asked.
 */
async function check(e: Entry, force: boolean) {
  if (e.checking) {
    e.again = { force: force || !!e.again?.force }
    return
  }
  e.checking = true
  try {
    const stamp = await api.changesStamp(e.cwd, e.machine).then(
      (r) => r.stamp,
      () => undefined,
    )
    if (!force && e.read && stamp === e.stamp) return
    e.loading[1](true)
    try {
      e.diff[1](await api.review(e.cwd, 'base', 3, e.machine))
      e.error[1](undefined)
    } catch (err) {
      e.error[1]((err as Error).message)
    } finally {
      e.read = true
      e.stamp = stamp
      e.loading[1](false)
    }
  } finally {
    e.checking = false
    const again = e.again
    e.again = undefined
    if (again) void check(e, again.force)
  }
}

function queue(e: Entry, force = false) {
  if (e.queued) {
    e.queued.force ||= force
    return
  }
  const asked = { force }
  e.queued = asked
  queueMicrotask(() => {
    e.queued = undefined
    void check(e, asked.force)
  })
}

// While the tab's in view, whatever's showing changes is checked on; coming back into view, at once.
setInterval(() => document.visibilityState === 'visible' && entries.forEach((e) => queue(e)), POLL_MS)
document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && entries.forEach((e) => queue(e)))

/**
 * The changes in `cwd`'s checkout, kept up to date while shown: a new diff only when they've changed, so anything
 * read along with them can go by it. What was read before shows meanwhile.
 */
export function useChanges(where: () => { cwd?: string; machine: string }, running: () => boolean) {
  const place = createMemo(
    () => {
      const { cwd, machine } = where()
      return cwd ? { cwd, machine } : undefined
    },
    undefined,
    { equals: (a, b) => a?.cwd === b?.cwd && a?.machine === b?.machine },
  )
  // Taken while shown, and let go with the last view of it, rather than kept for good.
  const [at, setAt] = createSignal<Entry>()
  createEffect(
    on(place, (p) => {
      if (!p) return setAt(undefined)
      const e = entryFor(p.cwd, p.machine)
      e.users++
      setAt(e)
      queue(e)
      onCleanup(() => {
        const key = keyOf(e.cwd, e.machine)
        if (--e.users === 0 && entries.get(key) === e) entries.delete(key)
      })
    }),
  )
  const reload = (force = false) => {
    const e = at()
    if (e) queue(e, force)
  }
  createEffect(on(running, (r) => !r && reload(), { defer: true }))
  // A base picked, or a branch switched to, is read whatever the stamp says, as the server keeps a base for a few seconds.
  createEffect(on(baseChanged, () => reload(true), { defer: true }))
  return {
    diff: () => at()?.diff[0](),
    error: () => at()?.error[0](),
    loading: () => !!at()?.loading[0](),
    reload: () => reload(true),
  }
}
