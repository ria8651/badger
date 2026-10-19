import { For, Show, createMemo, createResource, createSignal, onMount } from 'solid-js'
import { Check, CornerLeftUp, Eye, EyeOff, File, Folder, FolderGit2, FolderPlus, House, Upload } from '../icons'
import type { FileEntry, Listing } from '../../shared/protocol.ts'
import { api } from '../api.ts'
import { LOCAL } from '../machines.ts'
import { Button, Dialog, DialogTitle, GhostButton, inputClass, ltr, plural } from './ui.tsx'

/** Bytes as a short size, e.g. 1.2 GB. */
export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  while (bytes >= 1000 && i < units.length - 1) {
    bytes /= 1024
    i++
  }
  return `${bytes < 10 && i ? bytes.toFixed(1) : Math.round(bytes)} ${units[i]}`
}

const join = (dir: string, name: string) => `${dir.replace(/\/$/, '')}/${name}`

/** Where each kind of browsing left off, so the next one opens there. */
const LAST_KEY = 'badger.fileBrowser.'

/**
 * Browses a machine's disk in a modal. Picks a folder (`folder` mode: the one open, or a repo in it) or
 * files (`files` mode, with an upload from this device beside it). Folders open on click; files toggle.
 */
export function FileBrowser(props: {
  mode: 'folder' | 'files'
  title: string
  /** Whose disk; the hub's own if not given. Read once: a browser stays on one machine. */
  machine?: string
  /** Where to open; otherwise where the last browse of this mode on this machine ended, or home. */
  start?: string
  onClose: () => void
  onPickFolder?: (path: string) => void | Promise<void>
  onPickFiles?: (paths: string[]) => void
  /** Offered in files mode, to pick from this device instead. */
  onUpload?: () => void
}) {
  const machine = props.machine && props.machine !== LOCAL ? props.machine : undefined
  const lastKey = LAST_KEY + props.mode + (machine ? `.${machine}` : '')
  const [path, setPath] = createSignal<string | undefined>(props.start ?? localStorage.getItem(lastKey) ?? undefined)
  const [hidden, setHidden] = createSignal(false)
  const [filter, setFilter] = createSignal('')
  const [selected, setSelected] = createSignal<string[]>([])
  const [error, setError] = createSignal<string>()
  const [busy, setBusy] = createSignal(false)
  const [naming, setNaming] = createSignal(false)
  let filterInput!: HTMLInputElement

  const [listing] = createResource(
    () => ({ path: path(), hidden: hidden() }),
    async (q): Promise<Listing | undefined> => {
      setError()
      try {
        const l = await api.listDir(q.path, q.hidden, machine)
        localStorage.setItem(lastKey, l.path)
        return l
      } catch (e) {
        setError((e as Error).message)
        // A remembered folder may be gone: start again from home.
        if (q.path && !listing.latest) setPath(undefined)
        return listing.latest
      }
    },
  )
  const current = () => listing.latest?.path ?? path() ?? ''
  const go = (to: string) => {
    setFilter('')
    setNaming(false)
    setPath(to)
  }
  const entries = createMemo(() => {
    const q = filter().toLowerCase()
    return (listing.latest?.entries ?? []).filter((e) => !q || e.name.toLowerCase().includes(q))
  })

  const toggle = (file: string) => setSelected((s) => (s.includes(file) ? s.filter((f) => f !== file) : [...s, file]))
  const open = (e: FileEntry) => {
    const full = join(current(), e.name)
    if (e.dir) go(full)
    else if (props.mode === 'files') toggle(full)
  }

  const pickFolder = async (dir: string) => {
    setBusy(true)
    setError()
    try {
      await props.onPickFolder?.(dir)
      props.onClose()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const makeFolder = async (name: string) => {
    // Enter and then the blur from the box going away would both get here.
    if (!naming()) return
    setNaming(false)
    name = name.trim()
    if (!name) return
    try {
      const { path } = await api.makeFolder(join(current(), name), machine)
      go(path)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  onMount(() => filterInput.focus())

  return (
    <Dialog label={props.title} onClose={props.onClose} size="sm:h-[min(40rem,90vh)] sm:max-w-2xl">
      <DialogTitle title={props.title} onClose={props.onClose} />

      <div class="flex items-center gap-1 border-b border-line px-3 py-2">
        <GhostButton size="lg" title="Up a folder" disabled={!listing.latest?.parent} onClick={() => go(listing.latest!.parent!)}>
          <CornerLeftUp class="size-4" />
        </GhostButton>
        <GhostButton size="lg" title="Home" onClick={() => go('')}>
          <House class="size-4" />
        </GhostButton>
        <input
          value={current()}
          spellcheck={false}
          title="Type a path and press Enter"
          onKeyDown={(e) => {
            if (e.key === 'Enter') go(e.currentTarget.value.trim())
          }}
          onBlur={(e) => (e.currentTarget.value = current())}
          class={`${inputClass} min-w-0 flex-1 font-mono text-xs`}
        />
        <GhostButton size="lg" title={hidden() ? 'Hide hidden files' : 'Show hidden files'} onClick={() => setHidden((h) => !h)}>
          <Show when={hidden()} fallback={<EyeOff class="size-4" />}>
            <Eye class="size-4" />
          </Show>
        </GhostButton>
        <GhostButton size="lg" title="New folder" onClick={() => setNaming(true)}>
          <FolderPlus class="size-4" />
        </GhostButton>
      </div>

      <div class="px-3 pt-2">
        <input
          ref={filterInput}
          value={filter()}
          onInput={(e) => setFilter(e.currentTarget.value)}
          onKeyDown={(e) => {
            // Enter opens the only match, so typing a name and Enter walks down the tree.
            if (e.key === 'Enter' && entries().length === 1) open(entries()[0])
            if (e.key === 'Backspace' && !filter() && listing.latest?.parent) go(listing.latest.parent)
          }}
          placeholder="Filter"
          class={inputClass}
        />
      </div>

      <div class="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        <Show when={naming()}>
          <div class="flex items-center gap-3 rounded-lg px-2.5 py-1.5">
            <Folder class="size-4 shrink-0 text-fg-3" />
            <input
              ref={(el) => queueMicrotask(() => el.focus())}
              placeholder="Folder name, then Enter"
              onKeyDown={(e) => {
                if (e.key === 'Enter') makeFolder(e.currentTarget.value)
                // Handled, so it puts the name away rather than closing the browser.
                if (e.key === 'Escape') {
                  e.preventDefault()
                  setNaming(false)
                }
              }}
              onBlur={(e) => makeFolder(e.currentTarget.value)}
              class={`${inputClass} h-7`}
            />
          </div>
        </Show>
        <For each={entries()}>
          {(entry) => {
            const full = () => join(current(), entry.name)
            const picked = () => selected().includes(full())
            const inert = () => !entry.dir && props.mode === 'folder'
            return (
              <div
                role="button"
                tabindex={inert() ? -1 : 0}
                onClick={() => !inert() && open(entry)}
                onKeyDown={(e) => e.key === 'Enter' && !inert() && open(entry)}
                class={`group flex h-9 items-center gap-3 rounded-lg px-2.5 text-[13px] outline-none pointer-coarse:h-11 ${
                  inert() ? 'text-fg-3' : `cursor-pointer text-fg-2 hover:bg-surface hover:text-fg focus-visible:bg-surface ${picked() ? 'bg-surface text-fg' : ''}`
                }`}
              >
                <Show
                  when={entry.dir}
                  fallback={
                    <Show when={props.mode === 'files'} fallback={<File class="size-4 shrink-0" />}>
                      <span class={`grid size-4 shrink-0 place-items-center rounded-sm border ${picked() ? 'border-primary bg-primary text-on-primary' : 'border-edge'}`}>
                        <Show when={picked()}>
                          <Check class="size-3" stroke-width={3} />
                        </Show>
                      </span>
                    </Show>
                  }
                >
                  <Show when={entry.git} fallback={<Folder class="size-4 shrink-0 text-fg-3" />}>
                    <FolderGit2 class="size-4 shrink-0 text-accent" />
                  </Show>
                </Show>
                <span class="min-w-0 flex-1 truncate">{entry.name}</span>
                <Show when={entry.size !== undefined}>
                  <span class="shrink-0 text-xs text-fg-3 tabular-nums">{formatBytes(entry.size!)}</span>
                </Show>
                <Show when={entry.dir && props.mode === 'folder'}>
                  <button
                    type="button"
                    title={`Add ${entry.name} to Badger`}
                    onClick={(e) => {
                      e.stopPropagation()
                      void pickFolder(full())
                    }}
                    class="hidden h-6 shrink-0 rounded-button-md border border-button-edge shadow-(--shadow-control) px-2 text-xs text-fg-2 group-hover:block hover:bg-bg hover:text-fg pointer-coarse:block"
                  >
                    Add
                  </button>
                </Show>
              </div>
            )
          }}
        </For>
        <Show when={listing.latest && !entries().length && !naming()}>
          <p class="px-2.5 py-6 text-center text-[13px] text-fg-3">{filter() ? 'Nothing matches' : 'Empty folder'}</p>
        </Show>
        <Show when={listing.latest?.truncated}>
          <p class="px-2.5 py-2 text-xs text-fg-3">Only the first {listing.latest!.entries.length} are shown. Filter to narrow it down.</p>
        </Show>
      </div>

      <Show when={error()}>
        <p class="border-t border-line px-4 py-2 text-xs text-danger">{error()}</p>
      </Show>

      <div class="flex items-center gap-2 border-t border-line px-4 py-3">
        <Show
          when={props.mode === 'files'}
          fallback={
            <>
              <span class="min-w-0 flex-1 truncate text-left font-mono text-[11px] text-fg-3 [direction:rtl]">{ltr(current())}</span>
              <Button primary disabled={busy() || !listing.latest} onClick={() => pickFolder(current())}>
                Add this folder
              </Button>
            </>
          }
        >
          <Show when={props.onUpload}>
            <Button
              class="flex items-center gap-1.5"
              onClick={() => {
                props.onUpload!()
                props.onClose()
              }}
            >
              <Upload class="size-3.5" /> From this device
            </Button>
          </Show>
          <span class="flex-1 text-xs text-fg-3">{selected().length ? plural(selected().length, 'file') + ' selected' : ''}</span>
          <Button
            primary
            disabled={!selected().length}
            onClick={() => {
              props.onPickFiles?.(selected())
              props.onClose()
            }}
          >
            Attach
          </Button>
        </Show>
      </div>
    </Dialog>
  )
}
