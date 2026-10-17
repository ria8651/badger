import { For, Show, createSignal, type JSX } from 'solid-js'
import { render } from 'solid-js/web'
import { X } from '../icons'
import { Button, floatBy, inputClass, modalOpen, setModalOpen } from './ui.tsx'

/**
 * What a popover floats by: the control it's about, or a spot on the page such as a text selection.
 * Without one, or once the control has gone from the page, it sits at the top.
 */
export type Anchor = Element | DOMRect | undefined

/** A popover is open. Escape is its to close, so dialogs behind it leave Escape be. */
const [popoverOpen, setPopoverOpen] = createSignal(false)
export { popoverOpen }

/** Closes the one open now, since a new one replaces it. */
let closeCurrent: (() => void) | undefined

/**
 * Floats a panel by its anchor until it's closed: by the panel, Escape, clicking away or the window resizing.
 * A modal one takes focus and the page's keys, and gives focus back when it closes; one that isn't leaves focus
 * where it is, so an error doesn't interrupt typing.
 */
function float(
  anchor: Anchor,
  opts: { width: number; role: 'alert' | 'alertdialog' | 'dialog'; label: string; modal: boolean },
  panel: (close: () => void) => JSX.Element,
  onClose?: () => void,
) {
  closeCurrent?.()
  const width = Math.min(opts.width, innerWidth - 16)
  const before = document.activeElement as HTMLElement | null
  const wasModal = modalOpen()
  const host = document.createElement('div')
  document.body.append(host)

  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    closeCurrent = undefined
    removeEventListener('pointerdown', onOutside, true)
    removeEventListener('keydown', onKey, true)
    removeEventListener('resize', close)
    dispose()
    host.remove()
    setPopoverOpen(false)
    if (opts.modal) {
      setModalOpen(wasModal)
      if (before?.isConnected) before.focus()
    }
    onClose?.()
  }
  const onOutside = (e: PointerEvent) => !host.contains(e.target as Node) && close()
  // Caught first, so it closes this rather than also closing what's behind it or stopping Claude.
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return
    e.preventDefault()
    e.stopPropagation()
    close()
  }

  const place =
    anchor && (!(anchor instanceof Element) || anchor.isConnected)
      ? floatBy(anchor, width)
      : { left: `${Math.max(8, (innerWidth - width) / 2)}px`, top: '16px', 'max-height': `${innerHeight - 32}px` }
  const dispose = render(
    () => (
      <div
        role={opts.role}
        aria-label={opts.label}
        style={{ ...place, width: `${width}px` }}
        class="fixed z-[60] flex animate-[pop-in_120ms_ease-out] flex-col overflow-y-auto rounded-xl border border-edge bg-bg p-3 pop shadow-(--shadow-pop)"
      >
        {panel(close)}
      </div>
    ),
    host,
  )
  addEventListener('pointerdown', onOutside, true)
  addEventListener('keydown', onKey, true)
  addEventListener('resize', close)
  setPopoverOpen(true)
  if (opts.modal) setModalOpen(true)
  closeCurrent = close
}

/**
 * Asks before doing something that can't be undone, by the control that does it. The action has focus, so Enter
 * does it; Cancel, Escape or clicking away doesn't. Notes go under the question, for what else happens.
 */
export function confirmBy(anchor: Anchor, ask: { message: string; notes?: string[]; action: string }): Promise<boolean> {
  return new Promise((resolve) => {
    let yes = false
    float(
      anchor,
      { width: 320, role: 'alertdialog', label: ask.message, modal: true },
      (close) => (
        <>
          <p class="text-[13px] leading-snug text-fg">{ask.message}</p>
          <For each={ask.notes}>{(note) => <p class="mt-1.5 text-xs leading-snug text-fg-2">{note}</p>}</For>
          <div class="mt-3 flex justify-end gap-2">
            <Button onClick={close}>Cancel</Button>
            <Button
              danger
              ref={(el) => queueMicrotask(() => el.focus())}
              onClick={() => {
                yes = true
                close()
              }}
            >
              {ask.action}
            </Button>
          </div>
        </>
      ),
      () => resolve(yes),
    )
  })
}

/** Asks for a line of text by where it goes. Enter or the action gives what's typed; Escape or clicking away gives nothing. */
export function askBy(anchor: Anchor, ask: { label: string; value?: string; placeholder?: string; action: string }): Promise<string | undefined> {
  return new Promise((resolve) => {
    let answer: string | undefined
    let input!: HTMLInputElement
    float(
      anchor,
      { width: 320, role: 'dialog', label: ask.label, modal: true },
      (close) => {
        const submit = () => {
          answer = input.value
          close()
        }
        return (
          <>
            <label class="mb-1.5 text-xs text-fg-2">{ask.label}</label>
            <input
              ref={(el) => {
                input = el
                queueMicrotask(() => (el.focus(), el.select()))
              }}
              value={ask.value ?? ''}
              placeholder={ask.placeholder}
              onKeyDown={(e) => {
                // Not the page's shortcuts.
                if (e.key !== 'Escape') e.stopPropagation()
                if (e.key !== 'Enter' || e.isComposing) return
                // Or it goes on to what has focus once this closes, like typing a new line over the selection.
                e.preventDefault()
                submit()
              }}
              class={inputClass}
            />
            <div class="mt-3 flex justify-end gap-2">
              <Button onClick={close}>Cancel</Button>
              <Button primary onClick={submit}>
                {ask.action}
              </Button>
            </div>
          </>
        )
      },
      () => resolve(answer),
    )
  })
}

/**
 * Says something didn't work, by what was tried, until it's dismissed. The detail can be selected to copy; when
 * it's lines of output, from git say, it's monospace and scrolls.
 */
export function showError(title: string, detail: string, anchor?: Anchor) {
  float(anchor, { width: 380, role: 'alert', label: title, modal: false }, (close) => (
    <>
      <div class="flex items-start gap-2">
        <p class="min-w-0 flex-1 text-[13px] font-medium text-danger">{title}</p>
        <button
          type="button"
          title="Dismiss"
          onClick={close}
          class="-mt-1 -mr-1 grid size-6 shrink-0 place-items-center rounded-button-md text-fg-3 transition-colors hover:bg-surface hover:text-fg pointer-coarse:size-8"
        >
          <X class="size-3.5" />
        </button>
      </div>
      {/* Lines of output, like git's, keep their shape; a sentence reads as one. */}
      <Show when={detail.trim()}>
        <Show when={detail.trim().includes('\n')} fallback={<p class="mt-1 text-xs leading-snug text-fg-2 select-text">{detail.trim()}</p>}>
          <pre class="mt-1.5 max-h-60 overflow-auto font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-fg-2 select-text">{detail.trim()}</pre>
        </Show>
      </Show>
    </>
  ))
}
