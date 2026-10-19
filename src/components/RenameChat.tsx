import { Show, createSignal, onCleanup, type JSX } from 'solid-js'
import { Portal } from 'solid-js/web'
import { RefreshCw, Sparkles } from '../icons'
import type { SessionSummary } from '../../shared/protocol.ts'
import { api } from '../api.ts'
import { renameSession } from '../stores/sessions.ts'
import { showError } from './Popover.tsx'
import { createDismiss, floatBy } from './ui.tsx'

/**
 * A trigger that opens a box to rename a chat, floating over the page, with a
 * title from Claude offered as soon as it opens. Clicking the suggestion saves
 * it; Tab copies it into the box to tweak. Enter saves, Escape cancels, clicking
 * away keeps what you typed. The same wherever a chat can be renamed.
 */
export function RenameChat(props: {
  session: SessionSummary
  trigger: (open: () => boolean) => JSX.Element
  triggerClass: (open: boolean) => string
  title?: string
  onOpenChange?: (open: boolean) => void
}) {
  const [open, setOpen] = createSignal(false)
  const [place, setPlace] = createSignal<JSX.CSSProperties>({})
  const [suggestion, setSuggestion] = createSignal<string>()
  const [suggesting, setSuggesting] = createSignal(false)
  const [error, setError] = createSignal<string>()
  let trigger!: HTMLButtonElement
  let panel: HTMLDivElement | undefined
  let input: HTMLInputElement | undefined
  let typed = false
  const width = 352

  const suggest = () => {
    if (suggesting()) return
    setSuggesting(true)
    setError()
    api
      .suggestTitle(props.session.id)
      .then(({ title }) => setSuggestion(title), (e: Error) => setError(e.message))
      .finally(() => setSuggesting(false))
  }

  const show = () => {
    setPlace(floatBy(trigger, width))
    typed = false
    setSuggestion()
    setOpen(true)
    props.onOpenChange?.(true)
    suggest()
  }
  const close = (title?: string, refocus = true) => {
    if (!open()) return
    setOpen(false)
    props.onOpenChange?.(false)
    title = title?.trim()
    if (title && title !== props.session.title) {
      renameSession(props.session.id, title).catch((e: Error) => showError("Couldn't rename it", e.message, trigger))
    }
    if (refocus) trigger.focus()
  }

  // What's typed is kept; leaving it as suggested isn't.
  createDismiss(open, () => [panel, trigger], () => close(typed ? input?.value : undefined, false), { resize: true })
  onCleanup(() => open() && props.onOpenChange?.(false))

  return (
    <>
      <button
        ref={trigger}
        type="button"
        title={props.title}
        aria-haspopup="dialog"
        aria-expanded={open()}
        onClick={() => (open() ? close() : show())}
        class={props.triggerClass(open())}
      >
        {props.trigger(open)}
      </button>
      <Show when={open()}>
        <Portal>
          <div
            ref={panel}
            role="dialog"
            aria-label="Rename chat"
            style={{ ...place(), width: `${width}px` }}
            class="fixed z-40 flex animate-[pop-in_120ms_ease-out] flex-col rounded-xl border border-edge bg-bg pop shadow-(--shadow-pop)"
          >
            <input
              ref={(el) => {
                input = el
                queueMicrotask(() => (el.focus(), el.select()))
              }}
              value={props.session.title}
              onInput={() => (typed = true)}
              onKeyDown={(e) => {
                // Not the page's shortcuts.
                e.stopPropagation()
                if (e.key === 'Enter' && !e.isComposing) close(e.currentTarget.value)
                if (e.key === 'Escape') close()
                if (e.key === 'Tab' && suggestion()) {
                  e.preventDefault()
                  e.currentTarget.value = suggestion()!
                  typed = true
                }
              }}
              class="h-10 shrink-0 border-b border-line bg-transparent px-3.5 text-ui text-fg outline-none pointer-coarse:h-12 pointer-coarse:text-base"
            />
            <div class="flex items-center gap-1 p-1">
              <Show
                when={suggestion() && !suggesting()}
                fallback={
                  <span class={`flex min-w-0 flex-1 items-center gap-2 px-2.5 py-1.5 text-xs ${error() ? 'text-danger' : 'text-fg-3'}`}>
                    <Sparkles class={`size-3.5 shrink-0 ${error() ? '' : 'animate-pulse'}`} />
                    <span class="truncate">{error() ?? 'Suggesting a title…'}</span>
                  </span>
                }
              >
                <button
                  type="button"
                  onClick={() => close(suggestion())}
                  title="Use this title (Tab to edit it first)"
                  class="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-ui text-fg-2 transition-colors hover:bg-surface hover:text-fg pointer-coarse:py-2.5"
                >
                  <Sparkles class="size-3.5 shrink-0 text-fg-3" />
                  <span class="truncate">{suggestion()}</span>
                </button>
              </Show>
              <button
                type="button"
                onClick={suggest}
                disabled={suggesting()}
                title="Suggest another"
                class="grid size-7 shrink-0 place-items-center rounded-button-lg text-fg-3 transition-colors hover:bg-surface hover:text-fg disabled:invisible"
              >
                <RefreshCw class="size-3.5" />
              </button>
            </div>
          </div>
        </Portal>
      </Show>
    </>
  )
}
