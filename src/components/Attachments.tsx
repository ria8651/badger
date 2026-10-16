import { For, Show, createSignal, onCleanup } from 'solid-js'
import { Portal } from 'solid-js/web'
import { Columns3, FileText, GitFork, X } from '../icons'
import type { CardContext } from '../../shared/cardContext.ts'
import type { Move, Place } from '../../shared/forkNote.ts'
import type { ImageAttachment } from '../../shared/protocol.ts'
import { basename } from '../folders.ts'
import { imageUrl } from '../images.ts'
import { STATUS_LABELS } from './Board.tsx'
import { Markdown } from './Markdown.tsx'
import { modalOpen, plural } from './ui.tsx'

/**
 * Images as thumbnails, and big pastes and the card Claude was told about as
 * chips. Clicking a paste or the card shows its text underneath; clicking an
 * image shows it full size.
 */
export function Attachments(props: {
  pastes: string[]
  images: ImageAttachment[]
  card?: CardContext
  /** Where a fork moved to, as Claude was told. */
  move?: Move
  onRemovePaste?: (index: number) => void
  onRemoveImage?: (index: number) => void
  class?: string
}) {
  const [open, setOpen] = createSignal<number | 'card' | 'move'>()
  const [viewing, setViewing] = createSignal<ImageAttachment>()
  const openText = () => {
    const i = open()
    return typeof i === 'number' ? props.pastes[i] : undefined
  }
  const removePaste = (i: number) => {
    setOpen(undefined)
    props.onRemovePaste?.(i)
  }
  return (
    <div class={props.class}>
      <div class="flex flex-wrap items-end gap-1.5">
        <Show when={props.card}>
          {(context) => (
            <Show
              when={context().card}
              fallback={
                <span class={`${chip} gap-1.5 border-edge px-2.5 text-fg-3`}>
                  <Columns3 class="size-3.5" />
                  No longer on a card
                </span>
              }
            >
              {(card) => (
                <button
                  type="button"
                  title={card().title}
                  class={`${chip} max-w-72 gap-1.5 px-2.5 ${open() === 'card' ? 'border-fg-3 text-fg-2' : 'border-edge text-fg-3 hover:text-fg-2'}`}
                  onClick={() => setOpen(open() === 'card' ? undefined : 'card')}
                >
                  <Columns3 class="size-3.5 shrink-0" />
                  <span class="min-w-0 truncate">
                    #{card().id} {card().title}
                  </span>
                  <span class="shrink-0 opacity-70">{STATUS_LABELS[card().status]}</span>
                </button>
              )}
            </Show>
          )}
        </Show>
        <Show when={props.move}>
          {(move) => (
            <button
              type="button"
              title={`Forked from ${place(move().from)}`}
              class={`${chip} max-w-72 gap-1.5 px-2.5 ${open() === 'move' ? 'border-fg-3 text-fg-2' : 'border-edge text-fg-3 hover:text-fg-2'}`}
              onClick={() => setOpen(open() === 'move' ? undefined : 'move')}
            >
              <GitFork class="size-3.5 shrink-0" />
              <span class="min-w-0 truncate">Moved from {basename(move().from.cwd)}</span>
            </button>
          )}
        </Show>
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
            <div class={`${chip} ${open() === i() ? 'border-fg-3 text-fg-2' : 'border-edge text-fg-3 hover:text-fg-2'}`}>
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
      <Show when={open() === 'card' && props.card?.card}>
        {(card) => (
          <div class="mt-2 max-h-80 overflow-auto rounded-lg border border-edge px-3 py-2.5 text-[13px] text-fg-2">
            <a
              href={`/c/${card().id}`}
              onClick={(e) => {
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
                e.preventDefault()
                // App routes on popstate, so this navigates without a reload.
                history.pushState(null, '', `/c/${card().id}`)
                dispatchEvent(new PopStateEvent('popstate'))
              }}
              class="mb-1.5 block font-medium text-fg hover:underline"
            >
              #{card().id} {card().title}
            </a>
            <Show when={card().description} fallback={<p class="text-fg-3">No description</p>}>
              <Markdown text={card().description} />
            </Show>
          </div>
        )}
      </Show>
      <Show when={open() === 'move' && props.move}>
        {(move) => (
          <div class="mt-2 rounded-lg border border-edge px-3 py-2.5 text-[13px] text-fg-2">
            Forked from a chat in <span class="font-mono text-xs">{place(move().from)}</span>, and now in{' '}
            <span class="font-mono text-xs">{place(move().to)}</span>. Claude was told that paths from before may not be here.
          </div>
        )}
      </Show>
      <Show when={viewing()}>{(image) => <Lightbox image={image()} onClose={() => setViewing(undefined)} />}</Show>
    </div>
  )
}

const chip = 'flex h-7 items-center rounded-lg border text-xs transition-colors'

const place = (p: Place) => `${p.worktree ? 'a new worktree of ' : ''}${p.cwd} on ${p.machine}`

function Lightbox(props: { image: ImageAttachment; onClose: () => void }) {
  // Caught first and stopped, so Escape closes this rather than also stopping Claude from the composer.
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || modalOpen()) return
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
