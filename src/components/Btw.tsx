import { For, Show } from 'solid-js'
import { forkingSideChat, pickSideChat, shownSideChat, sideChatsOf } from '../btw.ts'
import { Plus, SquareArrowOutUpRight } from '../icons'
import { navigate } from '../router.tsx'
import { Chat } from './Chat.tsx'
import { LiveDot, Loading } from './ui.tsx'

const forkedLabel = (at?: number) => (at ? `Forked ${new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}` : '')

/**
 * A chat's side chats in a panel beside it: a strip of them, newest first,
 * and the one picked as a chat of its own. Each knows the chat as it was
 * when it was forked, so the strip says when that was.
 */
export function BtwPane(props: { parent: string; onNew: () => void; onReady: (focus: () => void) => void }) {
  let focusChat: (() => void) | undefined
  props.onReady(() => focusChat?.())
  const shown = () => shownSideChat(props.parent)
  const tab = 'flex h-7 min-w-0 max-w-56 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs transition-colors'
  return (
    <div class="flex size-full flex-col">
      <div class="flex shrink-0 items-center gap-1 border-b border-line px-2 py-1.5">
        <div class="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none]">
          <For each={sideChatsOf(props.parent)}>
            {(s) => (
              <button
                type="button"
                onClick={() => pickSideChat(props.parent, s.id)}
                title={[s.title, forkedLabel(s.forkedAt)].filter(Boolean).join('\n')}
                class={`${tab} ${s.id === shown() ? 'bg-surface text-fg' : 'text-fg-3 hover:bg-surface hover:text-fg-2'}`}
              >
                <Show when={s.running}>
                  <LiveDot />
                </Show>
                <span class="truncate">{s.title}</span>
              </button>
            )}
          </For>
        </div>
        <Show when={shown()}>
          {(id) => (
            <button
              type="button"
              onClick={() => navigate({ kind: 'chat', id: id() })}
              title="Open as a chat of its own"
              class="grid size-7 shrink-0 place-items-center rounded-md text-fg-3 transition-colors hover:bg-surface hover:text-fg-2"
            >
              <SquareArrowOutUpRight class="size-3.5" />
            </button>
          )}
        </Show>
        <button
          type="button"
          onClick={() => props.onNew()}
          title="New side chat"
          class="grid size-7 shrink-0 place-items-center rounded-md text-fg-3 transition-colors hover:bg-surface hover:text-fg-2"
        >
          <Plus class="size-3.5" />
        </button>
      </div>
      <div class="relative min-h-0 flex-1">
        <Show
          when={!forkingSideChat(props.parent) && shown()}
          keyed
          fallback={
            <Show
              when={forkingSideChat(props.parent)}
              fallback={
                <p class="mx-auto max-w-[46rem] px-6 pt-4 text-xs text-fg-3">
                  No side chats yet. Type <span class="font-mono">/btw</span> and a question in the chat to ask something on the side, in a
                  copy of the chat that leaves it alone.
                </p>
              }
            >
              <div class="flex h-full">
                <Loading />
              </div>
            </Show>
          }
        >
          {(id) => <Chat sessionId={id} embedded onReady={(focus) => (focusChat = focus)} />}
        </Show>
      </div>
    </div>
  )
}
