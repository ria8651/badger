import { For, Show, createSignal, onCleanup } from 'solid-js'
import { Portal } from 'solid-js/web'
import { FileText, X } from 'lucide-solid'
import type { ImageAttachment } from '../../shared/protocol.ts'
import { imageUrl } from '../images.ts'
import { plural } from './ui.tsx'

/**
 * Images as thumbnails and big pastes as chips. Clicking a paste shows its text
 * underneath; clicking an image shows it full size.
 */
export function Attachments(props: {
  pastes: string[]
  images: ImageAttachment[]
  onRemovePaste?: (index: number) => void
  onRemoveImage?: (index: number) => void
  class?: string
}) {
  const [open, setOpen] = createSignal<number>()
  const [viewing, setViewing] = createSignal<ImageAttachment>()
  const openText = () => {
    const i = open()
    return i === undefined ? undefined : props.pastes[i]
  }
  const removePaste = (i: number) => {
    setOpen(undefined)
    props.onRemovePaste?.(i)
  }
  return (
    <div class={props.class}>
      <div class="flex flex-wrap items-end gap-1.5">
        <For each={props.images}>
          {(image, i) => (
            <div class="group relative">
              <button type="button" onClick={() => setViewing(image)} title="View image">
                <img src={imageUrl(image)} alt="" class="block h-14 max-w-40 rounded-lg border border-edge object-cover" />
              </button>
              <Show when={props.onRemoveImage}>
                <button
                  type="button"
                  title="Remove"
                  onClick={() => props.onRemoveImage!(i())}
                  class="absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full border border-edge bg-bg text-fg-3 hover:text-fg"
                >
                  <X class="size-3" />
                </button>
              </Show>
            </div>
          )}
        </For>
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
              <Show when={props.onRemovePaste}>
                <button type="button" class="-ml-1 flex h-full items-center pr-2 hover:text-fg" title="Remove" onClick={() => removePaste(i())}>
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
      <Show when={viewing()}>{(image) => <Lightbox image={image()} onClose={() => setViewing(undefined)} />}</Show>
    </div>
  )
}

function Lightbox(props: { image: ImageAttachment; onClose: () => void }) {
  // Caught first and stopped, so Escape closes this rather than also stopping Claude from the composer.
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return
    e.stopPropagation()
    props.onClose()
  }
  addEventListener('keydown', onKey, true)
  onCleanup(() => removeEventListener('keydown', onKey, true))
  return (
    <Portal>
      <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-8" onClick={props.onClose}>
        <img src={imageUrl(props.image)} alt="" class="max-h-full max-w-full rounded-lg shadow-2xl" />
      </div>
    </Portal>
  )
}
