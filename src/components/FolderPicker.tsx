import { For, Show, createMemo, createResource, createSignal, type JSX } from 'solid-js'
import { Check, Folder as FolderIcon, FolderGit2, FolderPlus, GitBranch, MessageSquare, Plus, Trash2, X } from '../icons'
import type { Checkout, Folder } from '../../shared/protocol.ts'
import { api } from '../api.ts'
import { basename, scratchDir } from '../folders.ts'
import { machineOf, machines, severalMachines } from '../machines.ts'
import { FileBrowser, formatBytes } from './FileBrowser.tsx'
import { GitSummary } from './GitSummary.tsx'
import { confirmBy, showError } from './Popover.tsx'
import { ltr, plural } from './ui.tsx'

/** How many folders show before "Show more": the most recently used. */
const FOLDERS_SHOWN = 4

/**
 * Where a new chat starts, as a card per folder. A repo's card is its main checkout, with its
 * worktrees under it showing what's uncommitted, unpushed and unmerged, and a row to start in a
 * new one. Worktrees can be removed from here, and folders added through the file browser.
 * With more than one runner, which one it runs on is picked first, and everything below is that one's.
 */
export function FolderPicker(props: {
  /** The runner whose folders show. */
  machine: string
  selected?: string
  /** "New worktree" is picked, under the selected folder. */
  worktree: boolean
  /** What a new worktree will be called; Claude names it otherwise. */
  worktreeName?: string
  onPick: (cwd: string, worktree: boolean, machine: string) => void
}) {
  // Tagged with the runner they came from, so another's don't show while the new one's load; and never
  // rejected, since a runner that's offline or unreachable is ordinary here.
  const [folders, { refetch }] = createResource(
    () => props.machine,
    (machine) =>
      api.folders(machine).then(
        (list) => ({ machine, list, error: undefined }),
        (e: Error) => ({ machine, list: [] as Folder[], error: e.message }),
      ),
  )
  const current = () => (folders.latest?.machine === props.machine ? folders.latest : undefined)
  const listed = () => current()?.list ?? []
  const listError = () => current()?.error
  const [all, setAll] = createSignal(false)
  const [browsing, setBrowsing] = createSignal(false)
  /** The "No folder" directory, offered first. */
  const scratch = () => scratchDir(props.machine)
  const pick = (cwd: string, worktree: boolean) => props.onPick(cwd, worktree, props.machine)
  /** Where a runner starts once it's switched to: its "No folder", else its workspace. */
  const startOn = (id: string) => scratchDir(id) ?? machineOf(id)?.workspaceDir

  /** The folder holding the selection: its path, a checkout of it, or a folder inside it. */
  const holder = createMemo(() => {
    const cwd = props.selected
    if (!cwd) return undefined
    const list = listed()
    return (
      list.find((f) => f.path === cwd || f.checkouts?.some((c) => c.path === cwd)) ??
      list.find((f) => cwd.startsWith(`${f.path}/`) && !f.checkouts?.some((c) => !c.main && cwd.startsWith(`${c.path}/`)))
    )
  })
  /** Whether a row is the selection; a folder inside a checkout counts as that checkout. */
  const isSelected = (folder: Folder, path: string, main: boolean) => {
    const cwd = props.selected
    if (!cwd || props.worktree) return false
    if (cwd === path) return true
    return main && holder() === folder && !folder.checkouts?.some((c) => c.path === cwd)
  }
  const shown = () => {
    const list = listed()
    if (all() || list.length <= FOLDERS_SHOWN + 1) return list
    const top = list.slice(0, FOLDERS_SHOWN)
    const h = holder()
    return h && !top.includes(h) ? [...top, h] : top
  }

  const hide = (folder: Folder, button: Element) => {
    api.hideFolder(folder.path, props.machine).then(refetch, (e: Error) => showError("Couldn't take it off the list", e.message, button))
  }
  const removeWorktree = async (folder: Folder, c: Checkout, button: Element) => {
    const unmerged = c.git.base?.ahead ?? 0
    const notes = [
      unmerged && `Its branch ${c.git.branch} has ${plural(unmerged, 'unmerged commit')}, so it will be kept.`,
      c.unpushed && `${plural(c.unpushed, 'commit')} on it aren't on any remote.`,
    ].filter((note) => typeof note === 'string')
    if (!(await confirmBy(button, { message: `Delete worktree ${basename(c.path)}?`, notes, action: 'Delete' }))) return
    const machine = props.machine
    api
      .removeWorktree(c.path, machine)
      .then(() => {
        if (props.selected === c.path && props.machine === machine) pick(folder.path, false)
      })
      .catch((e: Error) => showError("Couldn't delete it", e.message, button))
      .finally(refetch)
  }

  return (
    <div class="mx-auto mt-5 w-full max-w-lg space-y-2 text-left">
      {/* Also with just the hub's own, if the one picked has gone offline or been removed, so there's a way off it. */}
      <Show when={severalMachines() || (machines().length && !machineOf(props.machine)?.online)}>
        <div class="flex flex-wrap items-center gap-1.5 pb-1" role="group" aria-label="Runner">
          <For each={machines()}>
            {(m) => (
              <button
                type="button"
                disabled={!m.online || !startOn(m.id)}
                aria-pressed={m.id === props.machine}
                onClick={() => m.id !== props.machine && props.onPick(startOn(m.id)!, false, m.id)}
                title={m.online ? (m.hostname ?? m.name) : `${m.name} is offline`}
                class={`flex h-7 items-center gap-1.5 rounded-button-round border px-3 text-xs transition-colors disabled:cursor-default pointer-coarse:h-9 ${
                  m.id === props.machine ? 'border-fg-3 bg-surface text-fg' : 'border-edge text-fg-2 enabled:hover:bg-surface enabled:hover:text-fg'
                } ${m.online ? '' : 'opacity-60'}`}
              >
                <span class={`size-1.5 shrink-0 rounded-full ${m.online ? 'bg-ok' : 'bg-fg-3'}`} />
                {m.name}
                <Show when={!m.online}>
                  <span class="text-fg-3">offline</span>
                </Show>
              </button>
            )}
          </For>
        </div>
      </Show>

      <Show when={scratch()}>
        {(scratch) => (
          <div class="rounded-xl border border-line shadow-(--shadow-card)">
            <Row selected={props.selected === scratch()} onClick={() => pick(scratch(), false)}>
              <MessageSquare class="size-4 shrink-0 text-fg-3" />
              <span class="text-[13px] text-fg-2">No folder</span>
              <span class="min-w-0 flex-1 truncate text-xs text-fg-3">Quick questions, not tied to a repo</span>
            </Row>
          </div>
        )}
      </Show>

      {/* Placeholders until the list comes, so it doesn't look like there are no folders. */}
      <Show when={!current()}>
        <For each={[0, 1, 2]}>
          {(i) => (
            <div class="flex min-h-14 items-center gap-2.5 rounded-xl border border-line px-3 shadow-(--shadow-card)" aria-hidden="true">
              <FolderIcon class="size-4 shrink-0 text-fg-3/40" />
              <div class="flex-1 animate-pulse space-y-1.5" style={{ 'animation-delay': `${i * 150}ms` }}>
                <div class="h-2.5 w-28 rounded-full bg-surface" />
                <div class="h-2 w-48 rounded-full bg-surface" />
              </div>
            </div>
          )}
        </For>
        <span class="sr-only">Loading folders…</span>
      </Show>

      <For each={shown()}>
        {(folder) => (
          <div class="group/card rounded-xl border border-line shadow-(--shadow-card)">
            <Show
              when={folder.checkouts}
              fallback={
                <Row selected={isSelected(folder, folder.path, true)} onClick={() => pick(folder.path, false)}>
                  <FolderIcon class="size-4 shrink-0 text-fg-3" />
                  <FolderName folder={folder} onHide={(button) => hide(folder, button)} />
                  <Size path={folder.path} machine={props.machine} />
                </Row>
              }
            >
              {(checkouts) => (
                <>
                  <For each={checkouts()}>
                    {(c) => (
                      <Show
                        when={!c.main}
                        fallback={
                          <Row selected={isSelected(folder, c.path, true)} onClick={() => pick(c.path, false)}>
                            <FolderGit2 class="size-4 shrink-0 text-fg-3" />
                            {/* The status drops under the name when the row's too narrow for both. */}
                            <div class="flex min-w-0 flex-1 flex-wrap items-center gap-x-3">
                              <FolderName folder={folder} onHide={(button) => hide(folder, button)} />
                              <GitSummary git={c.git} branch class="shrink-0 text-[11px]" />
                            </div>
                            <Size path={c.path} machine={props.machine} />
                          </Row>
                        }
                      >
                        <Row indent selected={isSelected(folder, c.path, false)} onClick={() => pick(c.path, false)}>
                          <GitBranch class="size-3.5 shrink-0 text-fg-3" />
                          <div class="flex min-w-0 flex-1 flex-wrap items-center gap-x-3">
                            <span class="flex min-w-32 flex-1 items-baseline gap-2" title={c.path}>
                              <span class="truncate font-mono text-xs text-fg-2">{basename(c.path)}</span>
                              <Show when={c.git.branch && !c.git.branch.endsWith(basename(c.path))}>
                                <span class="min-w-8 truncate font-mono text-[11px] text-fg-3">{c.git.branch}</span>
                              </Show>
                            </span>
                            <GitSummary git={c.git} class="shrink-0 text-[11px]" />
                          </div>
                          <Size path={c.path} machine={props.machine} />
                          {/* Faded rather than disabled while it has changes, so a click says why instead of picking the row. */}
                          <button
                            type="button"
                            aria-disabled={c.git.changes > 0}
                            onClick={(e) => {
                              e.stopPropagation()
                              if (!c.git.changes) return void removeWorktree(folder, c, e.currentTarget)
                              showError(
                                "Can't delete it yet",
                                `It has ${plural(c.git.changes, 'uncommitted change')}. Commit or discard them first, so nothing is lost.`,
                                e.currentTarget,
                              )
                            }}
                            title={c.git.changes ? 'Commit or discard its changes before deleting it' : 'Delete worktree (its branch goes too, if merged)'}
                            class="grid size-6 shrink-0 place-items-center rounded-md text-fg-3 opacity-0 transition group-hover/row:opacity-100 hover:bg-bg hover:text-danger focus-visible:opacity-100 aria-disabled:text-fg-3/40 aria-disabled:hover:bg-transparent aria-disabled:hover:text-fg-3/40 pointer-coarse:size-8 pointer-coarse:opacity-100"
                          >
                            <Trash2 class="size-3.5" />
                          </button>
                        </Row>
                      </Show>
                    )}
                  </For>
                  <Row
                    indent
                    selected={props.worktree && holder() === folder}
                    onClick={() => pick(checkouts()[0]?.path ?? folder.path, true)}
                  >
                    <Plus class="size-3.5 shrink-0 text-fg-3" />
                    <span class="text-xs text-fg-2">New worktree</span>
                    <span class="min-w-0 flex-1 truncate font-mono text-[11px] text-fg-3">
                      {props.worktreeName ?? 'named by Claude'}
                    </span>
                  </Row>
                </>
              )}
            </Show>
          </div>
        )}
      </For>

      <Show when={listError()}>
        <p class="px-2.5 text-xs text-danger">Couldn't list folders: {listError()}</p>
      </Show>

      <div class="flex items-center gap-1">
        <Show when={listed().length > shown().length}>
          <button
            type="button"
            onClick={() => setAll(true)}
            class="rounded-button-lg px-2.5 py-1.5 text-xs text-fg-3 transition-colors hover:bg-surface/60 hover:text-fg-2"
          >
            Show {listed().length - shown().length} more
          </button>
        </Show>
        <button
          type="button"
          onClick={() => setBrowsing(true)}
          class="ml-auto flex items-center gap-1.5 rounded-button-lg px-2.5 py-1.5 text-xs text-fg-3 transition-colors hover:bg-surface/60 hover:text-fg-2"
        >
          <FolderPlus class="size-3.5" /> Add a folder
        </button>
      </div>

      <Show when={browsing()}>
        <FileBrowser
          mode="folder"
          title="Add a folder to Badger"
          machine={props.machine}
          onClose={() => setBrowsing(false)}
          onPickFolder={async (path) => {
            await api.addFolder(path, props.machine)
            await refetch()
            pick(path, false)
          }}
        />
      </Show>
    </div>
  )
}

/** A pickable line on a folder's card; worktrees sit indented under their repo. */
function Row(props: { selected: boolean; indent?: boolean; onClick: () => void; children: JSX.Element }) {
  return (
    <div
      role="button"
      tabindex={0}
      aria-pressed={props.selected}
      onClick={props.onClick}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return
        e.preventDefault()
        props.onClick()
      }}
      class={`group/row flex min-h-10 cursor-pointer items-center gap-2.5 px-3 py-1.5 outline-none transition-colors first:rounded-t-xl last:rounded-b-xl focus-visible:bg-surface/60 pointer-coarse:min-h-12 ${
        props.indent ? 'border-t border-line pl-9' : ''
      } ${props.selected ? 'bg-surface' : 'hover:bg-surface/60'}`}
    >
      {props.children}
      <Check class={`size-3.5 shrink-0 text-fg-2 ${props.selected ? '' : 'invisible'}`} />
    </div>
  )
}

/** A folder's name and path, and a way to take it off the list. */
function FolderName(props: { folder: Folder; onHide: (button: Element) => void }) {
  return (
    <div class="min-w-32 flex-1">
      <div class="flex items-center gap-1">
        <span class="truncate text-[13px] text-fg">{basename(props.folder.path)}</span>
        <button
          type="button"
          title="Take off this list (nothing on disk changes)"
          onClick={(e) => {
            e.stopPropagation()
            props.onHide(e.currentTarget)
          }}
          class="grid size-5 shrink-0 place-items-center rounded-button-sm text-fg-3 opacity-0 transition group-hover/card:opacity-100 hover:bg-bg hover:text-fg focus-visible:opacity-100 pointer-coarse:hidden"
        >
          <X class="size-3" />
        </button>
      </div>
      <div class="truncate text-left font-mono text-[11px] text-fg-3 [direction:rtl]">{ltr(props.folder.path)}</div>
    </div>
  )
}

/** Space on disk, looked up when shown since it can take a moment. */
function Size(props: { path: string; machine: string }) {
  const [size] = createResource(() => props.path, (path) => api.folderSize(path, props.machine).then((s) => s.bytes))
  return (
    <span class="w-14 shrink-0 text-right text-[11px] text-fg-3 tabular-nums" title="Space on disk">
      <Show when={size.latest !== undefined} fallback={<span class="ml-auto block h-2 w-8 animate-pulse rounded-full bg-fg-3/15" />}>
        {formatBytes(size.latest!)}
      </Show>
    </span>
  )
}
