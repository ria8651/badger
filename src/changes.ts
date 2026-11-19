import { createEffect, createMemo, createSignal, on, type Accessor, type Setter } from 'solid-js'
import type { ReviewDiff } from '../shared/protocol.ts'
import { api } from './api.ts'
import { baseChanged } from './components/BasePicker.tsx'

/*
 * A checkout's changes against its base, read once for everything showing them: the files' tree, the chat's diff, a
 * file's diff and the file itself. So they agree, and a turn ending reads them once, not once per view. Three lines of
 * context, as the chat's diff shows them: its hunks are what's ticked off as viewed, wherever that's done.
 */

interface Entry {
  diff: [Accessor<ReviewDiff | undefined>, Setter<ReviewDiff | undefined>]
  error: [Accessor<string | undefined>, Setter<string | undefined>]
  loading: [Accessor<boolean>, Setter<boolean>]
  /** A read is asked for in this moment: however many ask, it's one. */
  queued: boolean
  reading: boolean
  /** Asked for again while a read was out: once that's back, read again, as what it read may be from before. */
  again: boolean
  /** When it was last read, so a view opened just after doesn't read it again. */
  readAt: number
}

/** How long what was read counts as current for a view being opened. */
const FRESH_MS = 5000

const entries = new Map<string, Entry>()

function entryFor(cwd: string, machine: string): Entry {
  const key = `${machine}\0${cwd}`
  let e = entries.get(key)
  if (!e) entries.set(key, (e = { diff: createSignal(), error: createSignal(), loading: createSignal(false), queued: false, reading: false, again: false, readAt: 0 }))
  return e
}

function read(e: Entry, cwd: string, machine: string) {
  if (e.reading) {
    e.again = true
    return
  }
  e.reading = true
  e.loading[1](true)
  api.review(cwd, 'base', 3, machine).then(
    (d) => {
      e.diff[1](d)
      e.readAt = Date.now()
      e.error[1](undefined)
    },
    (err: Error) => e.error[1](err.message),
  ).finally(() => {
    e.reading = false
    e.loading[1](false)
    if (e.again) {
      e.again = false
      read(e, cwd, machine)
    }
  })
}

/** Reads a checkout's changes again, once for everyone asking at the same moment. */
function reread(cwd: string, machine: string) {
  const e = entryFor(cwd, machine)
  if (e.queued) return
  e.queued = true
  queueMicrotask(() => {
    e.queued = false
    read(e, cwd, machine)
  })
}

/**
 * The changes in `cwd`'s checkout, read when first shown, when a turn ends (`running` going false) and when a base is
 * picked anywhere. What was read before shows meanwhile.
 */
export function useChanges(where: () => { cwd?: string; machine: string }, running: () => boolean) {
  const at = createMemo(() => {
    const { cwd, machine } = where()
    return cwd ? { cwd, machine, entry: entryFor(cwd, machine) } : undefined
  })
  const reload = () => {
    const a = at()
    if (a) reread(a.cwd, a.machine)
  }
  // Shown, it's read unless it just was: files change outside turns too, e.g. in a terminal.
  createEffect(
    on(at, (a) => {
      if (a && !a.entry.reading && Date.now() - a.entry.readAt > FRESH_MS) reload()
    }),
  )
  createEffect(on(running, (r) => !r && reload(), { defer: true }))
  createEffect(on(baseChanged, reload, { defer: true }))
  return {
    diff: () => at()?.entry.diff[0](),
    error: () => at()?.entry.error[0](),
    loading: () => !!at()?.entry.loading[0](),
    reload,
  }
}
