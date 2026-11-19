import { For, Show, createEffect, createMemo, createResource, createSignal, on, onMount, untrack } from 'solid-js'
import { Dynamic } from 'solid-js/web'
import { ChevronDown, ChevronRight, FileDiff, Folder, FolderOpen } from '../icons'
import type { ReviewFile } from '../../shared/protocol.ts'
import { api } from '../api.ts'
import { useChanges } from '../changes.ts'
import { STATUS_LETTER, STATUS_TONE } from '../fileIcons.ts'
import { plural } from '../format.ts'
import { Against } from './BasePicker.tsx'
import { useReview } from './Review.tsx'
import { DiffCount, FileTypeIcon, PaneBar, Segmented, ViewedBox, ViewedLine, inputClass } from './ui.tsx'

/*
 * SPIKE: a chat's checkout as a tree of files, beside it. All of them, to browse and open; or only the ones changed,
 * each opening its own diff, ticked off as they're read. Ticks are the chat's diff's, by hunk, so ticking a file here
 * ticks its hunks there, and a file Claude changes again comes back unread.
 */

export type FilesMode = 'all' | 'changes'

/** Past this many rows, the rest are left out: a filter that matches most of a big repo would hang the tab. */
const MAX_ROWS = 3000

interface Dir {
  name: string
  path: string
  dirs: Map<string, Dir>
  files: string[]
}

type Row = { kind: 'dir'; name: string; path: string; depth: number } | { kind: 'file'; name: string; path: string; depth: number }

/** Paths, relative to the checkout's top, as folders of folders and files. */
function treeOf(paths: string[]): Dir {
  const root: Dir = { name: '', path: '', dirs: new Map(), files: [] }
  for (const path of paths) {
    const parts = path.split('/')
    parts.pop()
    let at = root
    for (const part of parts) {
      let next = at.dirs.get(part)
      if (!next) at.dirs.set(part, (next = { name: part, path: at.path ? `${at.path}/${part}` : part, dirs: new Map(), files: [] }))
      at = next
    }
    at.files.push(path)
  }
  return root
}

const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1)
const byName = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })

/**
 * What's shown: folders first, then files, by name. A folder with only one folder in it shares its row, as a/b, and
 * opens with it. Under a closed folder nothing shows; with `all`, every folder's open, as when filtering.
 */
function rowsOf(root: Dir, isOpen: (path: string) => boolean, all: boolean): Row[] {
  const rows: Row[] = []
  const walk = (dir: Dir, depth: number) => {
    for (const d of [...dir.dirs.values()].sort((a, b) => byName(a.name, b.name))) {
      let at = d
      let name = d.name
      while (at.dirs.size === 1 && !at.files.length) {
        at = [...at.dirs.values()][0]
        name += `/${at.name}`
      }
      rows.push({ kind: 'dir', name, path: at.path, depth })
      if (all || isOpen(at.path)) walk(at, depth + 1)
    }
    for (const f of [...dir.files].sort((a, b) => byName(nameOf(a), nameOf(b)))) rows.push({ kind: 'file', name: nameOf(f), path: f, depth })
  }
  walk(root, 0)
  return rows
}

/** Which folders are open, per chat and way: all files start folded, changes open, so each keeps the folders that aren't. */
function useFolds(session: string, mode: () => FilesMode) {
  const key = () => `badger.files.${session}.${mode()}`
  const read = (k: string) => {
    try {
      return new Set<string>(JSON.parse(localStorage.getItem(k) ?? '[]'))
    } catch {
      return new Set<string>()
    }
  }
  const [flipped, setFlipped] = createSignal(read(untrack(key)))
  createEffect(on(key, (k) => setFlipped(read(k)), { defer: true }))
  const isOpen = (path: string) => flipped().has(path) !== (mode() === 'changes')
  const toggle = (path: string, open = !isOpen(path)) => {
    if (open === isOpen(path)) return
    const next = new Set(flipped())
    if (next.has(path)) next.delete(path)
    else next.add(path)
    setFlipped(next)
    localStorage.setItem(key(), JSON.stringify([...next]))
  }
  return { isOpen, toggle }
}

export function Files(props: {
  sessionId: string
  /** Where git runs. */
  cwd?: string
  machine: string
  mode: FilesMode
  onMode: (mode: FilesMode) => void
  /** Read again when a turn ends, since that's when files change. */
  running: boolean
  /** Opens a file, by absolute path: all of it, or its diff. */
  onOpen: (path: string, diff: boolean) => void
  /** Opens every change, file by file, on one page. */
  onFullDiff?: () => void
  onReady?: (focus: () => void) => void
}) {
  const [version, setVersion] = createSignal(0)
  createEffect(on(() => props.running, (r) => !r && setVersion((n) => n + 1), { defer: true }))

  const [listing] = createResource(
    () => (props.cwd ? { cwd: props.cwd, machine: props.machine, v: version() } : false),
    ({ cwd, machine }) => api.checkoutFiles(cwd, machine),
  )
  // The changes as the chat's diff has them, so its hunks are the ones ticked there.
  const changes = useChanges(
    () => ({ cwd: props.cwd, machine: props.machine }),
    () => props.running,
  )
  const diff = changes.diff
  const root = () => diff()?.root ?? listing.latest?.root
  const changed = createMemo(() => new Map((diff()?.files ?? []).map((f) => [f.path, f])))
  const error = () => (listing.error as Error | undefined)?.message ?? changes.error()

  // Ticked as the chat's diff ticks them, hunk by hunk: a file is viewed when all its hunks are.
  const review = useReview(
    untrack(() => props.sessionId),
    false,
  )
  const isViewed = (f: ReviewFile) => f.hunks.every((h) => review.isViewed(h.id))
  const setViewed = (files: ReviewFile[], on: boolean) =>
    review.setViewed(
      files.flatMap((f) => f.hunks.map((h) => h.id)),
      on,
    )

  const [filter, setFilter] = createSignal('')
  /** What's in the tree: the checkout's files, and any deleted since the base, or only those changed. */
  const paths = createMemo(() => {
    const q = filter().trim().toLowerCase()
    const all = props.mode === 'changes' ? [...changed().keys()] : [...new Set([...(listing.latest?.files ?? []), ...changed().keys()])]
    return q ? all.filter((p) => p.toLowerCase().includes(q)) : all
  })
  const tree = createMemo(() => treeOf(paths()))
  /** Each folder's changed files, for what its row says of them. */
  const changedUnder = createMemo(() => {
    const out = new Map<string, ReviewFile[]>()
    for (const p of paths()) {
      const f = changed().get(p)
      if (!f) continue
      for (let i = p.indexOf('/'); i >= 0; i = p.indexOf('/', i + 1)) {
        const dir = p.slice(0, i)
        out.set(dir, [...(out.get(dir) ?? []), f])
      }
    }
    return out
  })

  const folds = useFolds(untrack(() => props.sessionId), () => props.mode)
  const allRows = createMemo(() => rowsOf(tree(), folds.isOpen, !!filter().trim()))
  const rows = createMemo(() => allRows().slice(0, MAX_ROWS))

  // ── Moving about by keyboard ──

  const [cursor, setCursor] = createSignal<string>()
  const at = () => rows().findIndex((r) => r.path === cursor())
  let list!: HTMLDivElement
  let filterBox!: HTMLInputElement
  const rowEls = new Map<string, HTMLElement>()
  const moveTo = (i: number) => {
    const r = rows()[Math.max(0, Math.min(rows().length - 1, i))]
    if (!r) return
    setCursor(r.path)
    rowEls.get(r.path)?.scrollIntoView({ block: 'nearest' })
  }
  const open = (r: Row) => {
    if (r.kind === 'dir') return folds.toggle(r.path)
    const f = changed().get(r.path)
    if (root()) props.onOpen(`${root()}/${r.path}`, props.mode === 'changes' || f?.status === 'deleted')
  }
  const onKey = (e: KeyboardEvent) => {
    const r = rows()[at()]
    if (e.key === 'ArrowDown') moveTo(at() + 1)
    else if (e.key === 'ArrowUp') moveTo(at() - 1)
    else if (e.key === 'Home') moveTo(0)
    else if (e.key === 'End') moveTo(rows().length - 1)
    else if (e.key === 'ArrowRight' && r?.kind === 'dir') {
      if (folds.isOpen(r.path) || filter().trim()) moveTo(at() + 1)
      else folds.toggle(r.path, true)
    } else if (e.key === 'ArrowLeft' && r) {
      // Folds an open folder, else goes up to the one it's in.
      if (r.kind === 'dir' && folds.isOpen(r.path) && !filter().trim()) folds.toggle(r.path, false)
      else {
        const parent = rows().findLastIndex((x, i) => i < at() && x.kind === 'dir' && x.depth < r.depth)
        if (parent >= 0) moveTo(parent)
      }
    } else if (e.key === 'Escape' && r) setCursor()
    else if (e.key === 'Enter' && r) open(r)
    else if (e.key === ' ' && r?.kind === 'file' && props.mode === 'changes' && changed().has(r.path)) {
      const f = changed().get(r.path)!
      setViewed([f], !isViewed(f))
    } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      // Typing filters, from wherever the tree has focus.
      filterBox.focus()
      return
    } else return
    e.preventDefault()
  }
  onMount(() => props.onReady?.(() => list.focus({ preventScroll: true })))

  const totals = () => {
    const files = diff()?.files ?? []
    return { files: files.length, added: files.reduce((n, f) => n + f.added, 0), removed: files.reduce((n, f) => n + f.removed, 0), viewed: files.filter(isViewed).length }
  }

  return (
    <div class="@container flex size-full min-h-0 flex-col text-ui">
      <PaneBar>
        <Segmented
          value={props.mode}
          onChange={props.onMode}
          options={[
            {
              value: 'all',
              // Narrow, just "All", so the bar's buttons keep their room.
              label: (
                <>
                  All<span class="-ml-0.5 hidden @xs:inline">files</span>
                </>
              ),
              title: 'Every file in the checkout',
            },
            {
              value: 'changes',
              label: (
                <>
                  Changes
                  <Show when={totals().files}>
                    <span class="text-fg-3 tabular-nums">{totals().files}</span>
                  </Show>
                </>
              ),
              title: 'Only the files changed, each opening its diff',
            },
          ]}
        />
        {/* What the changes are against and how much of them, as the diff's and a file's bars have it. Narrow, the words go. */}
        <Show when={props.mode === 'changes' && diff()}>
          {(d) => (
            <Against
              dir={props.cwd}
              machine={props.machine}
              base={d().base}
              baseHow={d().baseHow}
              files={totals().files}
              added={totals().added}
              removed={totals().removed}
            />
          )}
        </Show>
        <div class="flex-1" />
        <div class="-mx-1.5 flex shrink-0 items-center">
          <Show when={props.onFullDiff}>
            {(full) => (
              <button
                onClick={full()}
                disabled={!totals().files}
                title="Every change, file by file, on one page"
                class="flex h-7 items-center gap-1.5 rounded-md px-1.5 text-xs text-fg-2 transition-colors hover:bg-surface hover:text-fg disabled:opacity-50"
              >
                <FileDiff class="size-3.5" />
                <span class="hidden @xs:inline">Full diff</span>
              </button>
            )}
          </Show>
        </div>
      </PaneBar>
      <Show when={props.mode === 'changes'}>
        <ViewedLine viewed={totals().viewed} total={totals().files} />
      </Show>

      <div class="flex items-center gap-2 px-2 pt-2 pb-1 text-xs text-fg-3">
        <input
          ref={filterBox}
          value={filter()}
          onInput={(e) => setFilter(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' || e.key === 'Enter') {
              e.preventDefault()
              list.focus()
              if (e.key === 'Enter') {
                const first = rows().find((r) => r.kind === 'file')
                if (first) {
                  setCursor(first.path)
                  open(first)
                }
              } else if (at() < 0) moveTo(0)
            }
            if (e.key === 'Escape' && filter()) {
              e.preventDefault()
              setFilter('')
            }
          }}
          placeholder="Filter files"
          spellcheck={false}
          class={`${inputClass} h-7 min-w-0 flex-1 px-2 text-xs`}
        />
      </div>

      <div
        ref={list}
        tabIndex={0}
        onKeyDown={onKey}
        // Clicking off the rows lets go of the one picked.
        onClick={(e) => e.target === e.currentTarget && setCursor()}
        class="group/tree min-h-0 flex-1 overflow-y-auto px-1 pt-1 pb-4 outline-none"
        role="tree"
      >
        <Show when={error()}>
          <p class="mx-2 my-2 rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">{error()}</p>
        </Show>
        <Show when={!props.cwd}>
          <p class="p-6 text-center text-fg-3">This chat has no folder to browse.</p>
        </Show>
        <For each={rows()}>
          {(r) => {
            const here = () => cursor() === r.path
            const indent = { 'padding-left': `${0.25 + r.depth * 0.875}rem` }
            const rowClass = () =>
              `flex h-7 w-full cursor-pointer items-center gap-1.5 rounded-md pr-2 text-left select-none pointer-coarse:h-9 ${
                // Where the keyboard is, only while it's in the tree: once a file's opened, the keyboard's there.
                here() ? 'hover:bg-surface/60 group-focus/tree:bg-surface group-focus/tree:ring-1 group-focus/tree:ring-edge' : 'hover:bg-surface/60'
              }`
            if (r.kind === 'dir') {
              const isOpen = () => !!filter().trim() || folds.isOpen(r.path)
              const under = () => changedUnder().get(r.path) ?? []
              const done = () => under().filter(isViewed).length
              return (
                <div
                  ref={(el) => rowEls.set(r.path, el)}
                  role="treeitem"
                  aria-expanded={isOpen()}
                  title={r.path}
                  style={indent}
                  onClick={() => {
                    setCursor(r.path)
                    open(r)
                  }}
                  class={rowClass()}
                >
                  <span class="grid w-3 shrink-0 place-items-center text-fg-3">
                    {isOpen() ? <ChevronDown class="size-3" /> : <ChevronRight class="size-3" />}
                  </span>
                  <Dynamic component={isOpen() ? FolderOpen : Folder} class="size-4 shrink-0 text-fg-3" />
                  <span
                    class={`min-w-0 flex-1 truncate ${under().length ? NAME_TONE[toneOf(under())] : 'text-fg-2'}`}
                    title={under().length ? `${r.path}\n${plural(under().length, 'file')} changed in here` : r.path}
                  >
                    {r.name}
                  </span>
                  {/* As a file's row has it, in the same places: how it changed, and in Changes, ticked off, all of it at once. */}
                  <Show when={under().length}>
                    <Show when={props.mode === 'changes' && done() < under().length}>
                      <span class="shrink-0 text-xs text-fg-3 tabular-nums">
                        {done()}/{under().length}
                      </span>
                    </Show>
                    <span class={`w-3 shrink-0 text-center font-mono text-xs ${STATUS_TONE[toneOf(under())]}`} title={toneOf(under())}>
                      {STATUS_LETTER[toneOf(under())]}
                    </span>
                    <Show when={props.mode === 'changes'}>
                      <ViewedBox label={false} viewed={done() === under().length} some={done() > 0} onChange={(on) => setViewed(under(), on)} />
                    </Show>
                  </Show>
                </div>
              )
            }
            const f = () => changed().get(r.path)
            const done = () => !!f() && isViewed(f()!)
            return (
              <div
                ref={(el) => rowEls.set(r.path, el)}
                role="treeitem"
                title={f()?.oldPath ? `${f()!.oldPath} → ${r.path}` : r.path}
                style={indent}
                onClick={() => {
                  setCursor(r.path)
                  open(r)
                }}
                class={rowClass()}
              >
                <span class="w-3 shrink-0" />
                <FileTypeIcon name={r.name} />
                <span
                  class={`min-w-0 flex-1 truncate ${
                    f()
                      ? `${NAME_TONE[f()!.status]} ${props.mode === 'changes' && done() ? 'opacity-60' : ''} ${f()!.generated ? 'opacity-60' : ''}`
                      : 'text-fg-2'
                  }`}
                >
                  {r.name}
                </span>
                <Show when={f()}>
                  {(file) => (
                    <>
                      <Show when={file().added || file().removed}>
                        <DiffCount files={1} added={file().added} removed={file().removed} class="shrink-0 text-xs" />
                      </Show>
                      <span class={`w-3 shrink-0 text-center font-mono text-xs ${STATUS_TONE[file().status]}`} title={file().status}>
                        {STATUS_LETTER[file().status]}
                      </span>
                      <Show when={props.mode === 'changes'}>
                        <ViewedBox label={false} viewed={done()} onChange={(on) => setViewed([file()], on)} />
                      </Show>
                    </>
                  )}
                </Show>
              </div>
            )
          }}
        </For>
        <Show when={allRows().length > MAX_ROWS}>
          <p class="px-3 py-2 text-xs text-fg-3">Only the first {MAX_ROWS} are shown. Filter to narrow it down.</p>
        </Show>
        <Show when={listing.latest?.truncated && props.mode === 'all'}>
          <p class="px-3 py-2 text-xs text-fg-3">The checkout has more files than can be listed: only the first {listing.latest!.files.length} are.</p>
        </Show>
        <Show when={props.cwd && !rows().length && (props.mode === 'changes' ? diff() : listing.latest)}>
          <p class="p-6 text-center text-fg-3">
            {filter().trim() ? 'Nothing matches' : props.mode === 'changes' ? 'No changes that aren’t on the base already.' : 'No files'}
          </p>
        </Show>
      </div>
    </div>
  )
}

/** How a folder's changed files changed, to colour it as they are: all the same way, or a mix, which is modified. */
const toneOf = (files: ReviewFile[]): ReviewFile['status'] => (files.every((f) => f.status === files[0].status) ? files[0].status : 'modified')

/** A changed file or folder's name, coloured as its letter is, and struck through if it's gone. */
const NAME_TONE = { ...STATUS_TONE, deleted: `${STATUS_TONE.deleted} line-through` }
