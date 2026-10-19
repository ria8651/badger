import { For, Show, createSignal, type Component, type JSX } from 'solid-js'
import { Columns3, FileText, GitFork, X } from '../icons'
import type { CardContext } from '../../shared/cardContext.ts'
import type { Move, Place } from '../../shared/forkNote.ts'
import { basename } from '../folders.ts'
import { imageUrl, type ShownImage } from '../images.ts'
import { STATUS_LABELS } from '../stores/cards.ts'
import { Link } from '../router.tsx'
import { Markdown } from './Markdown.tsx'
import { viewImages } from './ImageViewer.tsx'
import { plural } from './ui.tsx'

/**
 * Images as thumbnails, and big pastes, the card and other context Claude was
 * given with the prompt as chips. Clicking a chip shows what it holds
 * underneath; clicking an image opens the viewer.
 */
export function Attachments(props: {
  pastes: string[]
  images: ShownImage[]
  card?: CardContext
  /** Where a fork moved to, as Claude was told. */
  move?: Move
  /** Other context that went in with it, e.g. a skill's instructions or the CLAUDE.md files loaded. */
  context?: ContextChip[]
  onRemovePaste?: (index: number) => void
  onRemoveImage?: (index: number) => void
  class?: string
}) {
  const [open, setOpen] = createSignal<number | 'card' | 'move' | { context: number }>()
  const openContext = () => {
    const o = open()
    return typeof o === 'object' ? props.context?.[o.context] : undefined
  }
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
        <For each={props.context}>
          {(c, i) => {
            const shown = () => openContext() === c
            return (
              <button
                type="button"
                title={c.label}
                class={`${chip} max-w-72 gap-1.5 px-2.5 ${shown() ? 'border-fg-3' : 'border-edge'} ${c.danger ? 'text-danger' : shown() ? 'text-fg-2' : 'text-fg-3 hover:text-fg-2'}`}
                onClick={() => setOpen(shown() ? undefined : { context: i() })}
              >
                <c.icon class="size-3.5 shrink-0" />
                <span class="min-w-0 truncate">{c.label}</span>
                <Show when={c.meta}>
                  <span class="shrink-0 tabular-nums opacity-70">{c.meta}</span>
                </Show>
              </button>
            )
          }}
        </For>
        <For each={props.images}>
          {(image, i) => (
            <div class="group relative">
              <button type="button" class="cursor-zoom-in" onClick={() => viewImages(props.images.map(imageUrl), i())} title="View image">
                <img src={imageUrl(image)} alt="" loading="lazy" class="block h-14 max-w-40 rounded-lg border border-edge object-cover" />
              </button>
              <Show when={props.onRemoveImage}>
                <button
                  type="button"
                  title="Remove"
                  onClick={() => props.onRemoveImage!(i())}
                  class="absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-button-round border border-edge bg-bg text-fg-3 hover:text-fg"
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
      <Show when={openContext()}>
        {(c) => <div class="mt-2 max-h-80 overflow-auto rounded-lg border border-edge px-3 py-2.5 text-ui text-fg-2">{c().body()}</div>}
      </Show>
      <Show when={open() === 'card' && props.card?.card}>
        {(card) => (
          <div class="mt-2 max-h-80 overflow-auto rounded-lg border border-edge px-3 py-2.5 text-ui text-fg-2">
            <Link to={{ kind: 'card', id: card().id }} class="mb-1.5 block font-medium text-fg hover:underline">
              #{card().id} {card().title}
            </Link>
            <Show when={card().description} fallback={<p class="text-fg-3">No description</p>}>
              <Markdown text={card().description} />
            </Show>
          </div>
        )}
      </Show>
      <Show when={open() === 'move' && props.move}>
        {(move) => (
          <div class="mt-2 rounded-lg border border-edge px-3 py-2.5 text-ui text-fg-2">
            Forked from a chat in <span class="font-mono text-xs">{place(move().from)}</span>, and now in{' '}
            <span class="font-mono text-xs">{place(move().to)}</span>. Claude was told that paths from before may not be here.
          </div>
        )}
      </Show>
    </div>
  )
}

const chip = 'flex h-7 items-center rounded-lg border text-xs transition-colors'

/** Context that went in with a prompt, as a chip that opens to `body`. */
export interface ContextChip {
  icon: Component<{ class?: string }>
  label: string
  meta?: string
  /** It's about something that failed, e.g. a hook. */
  danger?: boolean
  body: () => JSX.Element
}

const place = (p: Place) => `${p.worktree ? 'a new worktree of ' : ''}${p.cwd} on ${p.machine}`
