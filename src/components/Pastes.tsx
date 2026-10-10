import { For, Show, createSignal } from 'solid-js'
import { FileText, X } from 'lucide-solid'
import { plural } from './ui.tsx'

/** Big pastes as chips; clicking one shows its text underneath. */
export function Pastes(props: { pastes: string[]; onRemove?: (index: number) => void; class?: string }) {
  const [open, setOpen] = createSignal<number>()
  const openText = () => {
    const i = open()
    return i === undefined ? undefined : props.pastes[i]
  }
  const remove = (i: number) => {
    setOpen(undefined)
    props.onRemove?.(i)
  }
  return (
    <div class={props.class}>
      <div class="flex flex-wrap gap-1.5">
        <For each={props.pastes}>
          {(text, i) => (
            <div
              class={`flex h-7 items-center rounded-lg border text-xs transition-colors ${open() === i() ? 'border-fg-3 text-fg-2' : 'border-edge text-fg-3 hover:text-fg-2'}`}
            >
              <button type="button" class="flex h-full items-center gap-1.5 pl-2 pr-2.5" onClick={() => setOpen(open() === i() ? undefined : i())}>
                <FileText class="size-3.5" />
                Pasted text
                <span class="tabular-nums opacity-70">{plural(text.split('\n').length, 'line')}</span>
              </button>
              <Show when={props.onRemove}>
                <button type="button" class="-ml-1 flex h-full items-center pr-2 hover:text-fg" title="Remove" onClick={() => remove(i())}>
                  <X class="size-3" />
                </button>
              </Show>
            </div>
          )}
        </For>
      </div>
      <Show when={openText()}>
        {(text) => (
          <pre class="mt-2 max-h-80 overflow-auto rounded-lg border border-edge px-3 py-2.5 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words text-fg-2">
            {text()}
          </pre>
        )}
      </Show>
    </div>
  )
}
