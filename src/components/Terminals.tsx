import { For, Show, createEffect, createMemo, on, onCleanup } from 'solid-js'
import { ChevronDown, Plus, RotateCw, SquareArrowOutUpRight, SquareTerminal, Trash2, X } from 'lucide-solid'
import type { TerminalInfo } from '../../shared/protocol.ts'
import { api } from '../api.ts'
import { onMachine, unplace, type Place } from '../folders.ts'
import { dockHeight, dockState, setDock, setDockHeight, terminalLabel, terminalState, terminalWorkspace, terminals } from '../terminals.ts'
import { TerminalView } from './TerminalView.tsx'
import { ltr } from './ui.tsx'

/** Green while running, red if it failed or was killed, grey once it exited cleanly. */
export function StatusDot(props: { terminal: TerminalInfo }) {
  const tone = () => (props.terminal.running ? 'bg-ok' : props.terminal.signal || props.terminal.exitCode ? 'bg-danger' : 'bg-fg-3')
  return <span title={terminalState(props.terminal)} class={`inline-block size-1.5 shrink-0 rounded-full ${tone()}`} />
}

const inWorkspace = (root: Place) => terminals().filter((t) => terminalWorkspace(t) === root)

/** Opens a shell in the workspace, on its machine, and makes it the dock's active tab. */
async function newShell(root: Place, cwd: string): Promise<void> {
  try {
    const t = await api.createTerminal({ cwd, machine: unplace(root).machine })
    setDock(root, { open: true, active: t.id })
  } catch (err) {
    // An open dock with nothing in it would look like nothing happened.
    if (inWorkspace(root).length === 0) setDock(root, { open: false })
    alert(`Couldn't open a terminal: ${err instanceof Error ? err.message : err}`)
  }
}

/** Show or hide a workspace's dock. Opening one with no terminals starts a shell, like any terminal panel. */
export function toggleDock(root: Place, cwd: string): void {
  const open = !dockState(root).open
  setDock(root, { open })
  if (open && inWorkspace(root).length === 0) void newShell(root, cwd)
}

const ghost = (active = false) =>
  `grid size-7 shrink-0 place-items-center rounded-md transition-colors hover:bg-surface hover:text-fg ${active ? 'text-fg' : 'text-fg-3'}`

/** For the composer: toggles the dock and says how many terminals are running here. */
export function TerminalButton(props: { root: Place; cwd: string }) {
  const running = () => inWorkspace(props.root).filter((t) => t.running).length
  const open = () => dockState(props.root).open
  return (
    <button
      type="button"
      onClick={() => toggleDock(props.root, props.cwd)}
      title={`${open() ? 'Hide' : 'Show'} terminals (Ctrl+\`)`}
      class={`flex h-7 items-center gap-1 rounded-md px-2 text-xs tabular-nums transition-colors hover:bg-surface hover:text-fg-2 pointer-coarse:h-9 ${
        open() ? 'bg-surface text-fg-2' : 'text-fg-3'
      }`}
    >
      <SquareTerminal class="size-3.5" />
      <Show when={running()}>{running()}</Show>
    </button>
  )
}

/**
 * The workspace's terminals, docked under a chat. Every chat in the same
 * workspace (on the same machine) shows the same terminals; which tab is open
 * and whether the dock is showing are remembered per workspace.
 */
export function TerminalDock(props: { root: Place; cwd: string; onOpenPage: (id: string) => void; onHide: () => void }) {
  const list = createMemo(() => inWorkspace(props.root))
  const state = () => dockState(props.root)
  const active = () => {
    const ids = list().map((t) => t.id)
    const want = state().active
    return want && ids.includes(want) ? want : ids[0]
  }
  const current = () => list().find((t) => t.id === active())

  // Closing the last terminal (or it exiting) hides the dock.
  createEffect(on(() => list().length, (n, prev) => n === 0 && prev && state().open && setDock(props.root, { open: false })))

  // Focus follows the active tab whenever the dock opens or switches, once that view has mounted.
  const focusers = new Map<string, () => void>()
  let wantFocus: string | undefined
  createEffect(
    on([() => state().open, active], ([open, id]) => {
      if (!open || !id) return
      wantFocus = id
      focusers.get(id)?.()
    }),
  )
  const ready = (id: string, focus: () => void) => {
    focusers.set(id, focus)
    if (wantFocus === id) focus()
  }

  const hide = () => {
    setDock(props.root, { open: false })
    props.onHide()
  }

  const onKey = (e: KeyboardEvent) => {
    if (!(e.ctrlKey && e.key === '`')) return
    e.preventDefault()
    if (state().open) hide()
    else toggleDock(props.root, props.cwd)
  }
  addEventListener('keydown', onKey)
  onCleanup(() => removeEventListener('keydown', onKey))

  const close = (t: TerminalInfo) => {
    if (t.id === active()) {
      const rest = list().filter((x) => x.id !== t.id)
      const i = list().findIndex((x) => x.id === t.id)
      setDock(props.root, { active: rest[Math.min(i, rest.length - 1)]?.id })
    }
    void api.closeTerminal(t.id)
  }

  const startDrag = (e: PointerEvent) => {
    e.preventDefault()
    const startY = e.clientY
    const startHeight = dockHeight()
    const move = (m: PointerEvent) => setDockHeight(Math.round(Math.max(120, Math.min(innerHeight - 160, startHeight + startY - m.clientY))))
    const up = () => {
      removeEventListener('pointermove', move)
      removeEventListener('pointerup', up)
    }
    addEventListener('pointermove', move)
    addEventListener('pointerup', up)
  }

  return (
    <Show when={state().open && list().length > 0}>
      <div class="relative flex shrink-0 flex-col border-t border-line" style={{ height: `${dockHeight()}px` }}>
        <div onPointerDown={startDrag} class="absolute inset-x-0 -top-1 z-10 h-2 cursor-row-resize" />
        <div class="flex h-10 shrink-0 items-center gap-0.5 px-2">
          <div class="flex min-w-0 items-center gap-0.5 overflow-x-auto [scrollbar-width:none]">
            <For each={list()}>
              {(t) => (
                <div
                  class={`group flex h-7 max-w-56 shrink-0 items-center rounded-md transition-colors ${
                    t.id === active() ? 'bg-surface text-fg' : 'text-fg-3 hover:bg-surface/60 hover:text-fg-2'
                  }`}
                >
                  <button
                    onClick={() => setDock(props.root, { active: t.id })}
                    title={`${terminalLabel(t)}\n${t.cwd}`}
                    class="flex h-full min-w-0 items-center gap-1.5 pl-2 text-xs"
                  >
                    <StatusDot terminal={t} />
                    <span class="truncate">{terminalLabel(t)}</span>
                  </button>
                  <button
                    onClick={() => close(t)}
                    title="Delete terminal: stops it and everything it started"
                    class={`mx-0.5 grid size-5 shrink-0 place-items-center rounded text-fg-3 transition-colors hover:text-fg ${
                      t.id === active() ? '' : 'invisible group-hover:visible'
                    }`}
                  >
                    <X class="size-3" />
                  </button>
                </div>
              )}
            </For>
          </div>
          <button onClick={() => newShell(props.root, props.cwd)} title="New terminal" class={ghost()}>
            <Plus class="size-3.5" />
          </button>
          <div class="flex-1" />
          <Show when={current()}>
            {(t) => (
              <>
                <RestartButton terminal={t()} />
                <button onClick={() => props.onOpenPage(t().id)} title="Open on its own page" class={ghost()}>
                  <SquareArrowOutUpRight class="size-3.5" />
                </button>
              </>
            )}
          </Show>
          <button onClick={hide} title="Hide terminals (Ctrl+`)" class={ghost()}>
            <ChevronDown class="size-3.5" />
          </button>
        </div>
        <div class="relative min-h-0 flex-1">
          <For each={list()}>
            {(t) => (
              <TerminalView
                id={t.id}
                visible={t.id === active()}
                onReady={(focus) => ready(t.id, focus)}
                class={`absolute inset-0 px-3 py-2 ${t.id === active() ? '' : 'hidden'}`}
              />
            )}
          </For>
        </div>
      </div>
    </Show>
  )
}

/** Runs a terminal's command again. Shells don't get one: restarting a shell is just closing it and opening another. */
function RestartButton(props: { terminal: TerminalInfo }) {
  return (
    <Show when={props.terminal.command}>
      <button onClick={() => api.restartTerminal(props.terminal.id)} title="Restart: stop it and run the command again" class={ghost()}>
        <RotateCw class="size-3.5" />
      </button>
    </Show>
  )
}

/** One terminal filling the page, at /t/:id. */
export function TerminalPage(props: { id: string; onClosed: () => void }) {
  const terminal = () => terminals().find((t) => t.id === props.id)

  return (
    <div class="flex h-full min-w-0 flex-1 flex-col">
      <Show
        when={terminal()}
        fallback={<p class="flex flex-1 items-center justify-center text-[13px] text-fg-3">This terminal is closed</p>}
      >
        {(t) => (
          <>
            <div class="flex h-12 shrink-0 items-center gap-2 px-5 text-[13px]">
              <StatusDot terminal={t()} />
              <span class="truncate text-fg">{terminalLabel(t())}</span>
              <span class="min-w-0 flex-1 truncate text-left font-mono text-[11px] text-fg-3 [direction:rtl]">{ltr(t().cwd)}</span>
              <Show when={onMachine(t().machine)}>{(name) => <span class="shrink-0 text-xs text-fg-3">{name()}</span>}</Show>
              <span class="shrink-0 text-xs text-fg-3">{terminalState(t())}</span>
              <RestartButton terminal={t()} />
              <button
                onClick={() => api.closeTerminal(t().id).then(props.onClosed)}
                title="Delete terminal: stops it and everything it started"
                class={ghost()}
              >
                <Trash2 class="size-3.5" />
              </button>
            </div>
            <TerminalView
              id={t().id}
              visible
              onReady={(focus) => focus()}
              class="min-h-0 flex-1 border-t border-line px-5 py-3"
            />
          </>
        )}
      </Show>
    </div>
  )
}
