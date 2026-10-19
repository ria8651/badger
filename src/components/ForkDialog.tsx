import { Show, createSignal } from 'solid-js'
import { api } from '../api.ts'
import { FolderPicker } from './FolderPicker.tsx'
import { Button, Dialog, DialogTitle } from './ui.tsx'

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

  return (
    <Dialog label="Fork chat" onClose={props.onClose} size="sm:h-auto sm:max-h-[90vh] sm:max-w-xl">
      <DialogTitle title="Fork from here" onClose={props.onClose} />
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
    </Dialog>
  )
}
