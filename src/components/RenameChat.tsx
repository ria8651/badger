import { Show, createSignal, onMount } from 'solid-js'
import { RefreshCw, Sparkles } from 'lucide-solid'
import type { SessionSummary } from '../../shared/protocol.ts'
import { api } from '../api.ts'

/**
 * Edits a chat's title in place, with a title from Claude offered alongside
 * as soon as it opens. Clicking the suggestion saves it; Tab copies it into
 * the box to tweak. Enter saves, Escape cancels, clicking away keeps what you typed.
 * Laid out by the caller's class: stacked in the sidebar, inline on a card.
 */
export function RenameChat(props: { session: SessionSummary; onSaved?: (title: string) => void; onDone: () => void; class?: string }) {
  let input!: HTMLInputElement
  let typed = false
  let done = false
  const [suggestion, setSuggestion] = createSignal<string>()
  const [suggesting, setSuggesting] = createSignal(false)
  const [error, setError] = createSignal<string>()

  const suggest = () => {
    if (suggesting()) return
    setSuggesting(true)
    setError()
    api
      .suggestTitle(props.session.id)
      .then(({ title }) => setSuggestion(title), (e: Error) => setError(e.message))
      .finally(() => setSuggesting(false))
  }

  const finish = (title?: string) => {
    if (done) return
    done = true
    title = title?.trim()
    if (title && title !== props.session.title) {
      props.onSaved?.(title)
      api.rename(props.session.id, title).catch((e: Error) => alert(`Couldn't rename: ${e.message}`))
    }
    props.onDone()
  }

  onMount(() => {
    input.focus()
    input.select()
    suggest()
  })

  return (
    // Buttons keep focus in the box, so clicking them doesn't end the edit.
    <div class={props.class} onMouseDown={(e) => e.target !== input && e.preventDefault()}>
      <input
        ref={input}
        value={props.session.title}
        onInput={() => (typed = true)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') finish(input.value)
          if (e.key === 'Escape') finish()
          if (e.key === 'Tab' && suggestion()) {
            e.preventDefault()
            input.value = suggestion()!
            typed = true
          }
        }}
        onBlur={() => finish(typed ? input.value : undefined)}
        class="-mx-1 min-w-0 flex-1 rounded bg-bg px-1 text-[13px] text-fg ring-1 ring-edge outline-none"
      />
      <div class="flex min-w-0 items-center gap-1 text-[11px] text-fg-3">
        <Show
          when={suggestion() && !suggesting()}
          fallback={
            <span class={`flex items-center gap-1 truncate ${error() ? 'text-danger' : ''}`}>
              <Sparkles class={`size-3 shrink-0 ${error() ? '' : 'animate-pulse'}`} />
              {error() ?? 'Suggesting a title…'}
            </span>
          }
        >
          <button
            type="button"
            onClick={() => finish(suggestion())}
            title="Use this title (Tab to edit it first)"
            class="flex min-w-0 items-center gap-1 rounded text-fg-2 hover:text-fg"
          >
            <Sparkles class="size-3 shrink-0" />
            <span class="truncate">{suggestion()}</span>
          </button>
        </Show>
        <button
          type="button"
          onClick={suggest}
          disabled={suggesting()}
          title="Suggest another"
          class="grid size-3.5 shrink-0 place-items-center rounded hover:text-fg disabled:invisible"
        >
          <RefreshCw class="size-3" />
        </button>
      </div>
    </div>
  )
}
