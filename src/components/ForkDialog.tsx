import { Show, createSignal, onCleanup, onMount } from 'solid-js'
import { Portal } from 'solid-js/web'
import { X } from '../icons'
import { api } from '../api.ts'
import { FolderPicker } from './FolderPicker.tsx'
import { popoverOpen } from './Popover.tsx'
import { Button, setModalOpen } from './ui.tsx'

/**
 * Where a fork of the chat goes: where the chat is now unless another folder,
 * runner or a new worktree is picked. Nothing on disk is copied; the new chat
 * is told it moved, if it did.
 */
export function ForkDialog(props: {
  sessionId: string
  /** The end of the turn it's forked from. */
  at: string
  machine: string
  cwd?: string
  onForked: (sessionId: string) => void
  onClose: () => void
}) {
  const [machine, setMachine] = createSignal(props.machine)
  const [cwd, setCwd] = createSignal(props.cwd)
  const [worktree, setWorktree] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string>()
  let dialog!: HTMLDivElement
  let downOnBackdrop = false

  const fork = async () => {
    setBusy(true)
    setError()
    try {
      const moved = machine() !== props.machine || cwd() !== props.cwd || worktree()
      const { sessionId } = await api.fork(props.sessionId, {
        at: props.at,
        ...(moved ? { machine: machine(), cwd: cwd() } : {}),
        // Claude names it: the card's name is likely the worktree this chat is already in.
        ...(worktree() ? { worktree: '' } : {}),
      })
      props.onForked(sessionId)
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  const before = document.activeElement as HTMLElement | null
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || e.defaultPrevented || popoverOpen()) return
    // Caught first, so it closes this rather than also stopping Claude from the composer.
    e.stopPropagation()
    props.onClose()
  }
  addEventListener('keydown', onKey, true)
  setModalOpen(true)
  onCleanup(() => {
    setModalOpen(false)
    removeEventListener('keydown', onKey, true)
    before?.focus()
  })
  onMount(() => dialog.focus())

  return (
    <Portal>
      <div
        class="fixed inset-0 z-50 flex animate-[fade-in_120ms_ease-out] items-center justify-center bg-black/40 sm:p-6"
        onPointerDown={(e) => (downOnBackdrop = e.target === e.currentTarget)}
        onClick={(e) => e.target === e.currentTarget && downOnBackdrop && props.onClose()}
      >
        <div
          ref={dialog}
          role="dialog"
          aria-modal="true"
          aria-label="Fork chat"
          tabindex={-1}
          class="flex h-full w-full flex-col overflow-hidden border-edge bg-bg p-(--inset) shadow-(--shadow-modal) outline-none sm:h-auto sm:max-h-[90vh] sm:max-w-xl sm:rounded-xl sm:border-(length:--dialog-border)"
        >
          <div class="bar flex items-center gap-2 border-b border-line px-4 py-3">
            <h2 class="flex-1 text-sm font-medium text-fg">Fork from here</h2>
            <button
              type="button"
              title="Close"
              onClick={props.onClose}
              class="grid size-8 shrink-0 place-items-center rounded-button-lg text-fg-3 transition-colors hover:bg-surface hover:text-fg"
            >
              <X class="size-4" />
            </button>
          </div>
          <div class="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
            <FolderPicker
              machine={machine()}
              selected={cwd()}
              worktree={worktree()}
              onPick={(dir, wt, m) => {
                setMachine(m)
                setCwd(dir)
                setWorktree(wt)
              }}
            />
          </div>
          <div class="flex items-center gap-2 border-t border-line px-4 py-3">
            <p class="min-w-0 flex-1 text-xs text-fg-3">
              <Show when={error()} fallback="Files aren't copied. Moving it just tells Claude where it is now.">
                <span class="text-danger">{error()}</span>
              </Show>
            </p>
            <Button onClick={props.onClose}>Cancel</Button>
            <Button primary disabled={busy() || !cwd()} onClick={fork}>
              {busy() ? 'Forking…' : 'Fork'}
            </Button>
          </div>
        </div>
      </div>
    </Portal>
  )
}
