import { For, createEffect, createMemo, createSignal, createUniqueId, on } from 'solid-js'
import { attention } from '../attention.ts'
import { searchChats } from '../chatSearch.ts'
import { navigate } from '../router.tsx'
import { cardOf } from '../stores/cards.ts'
import { sessions } from '../stores/sessions.ts'
import { ChatSummary } from './ChatSummary.tsx'
import { Dialog } from './ui.tsx'

/** No more are listed than this; typing more of a name finds the rest. */
const MAX = 50

/**
 * Goes to any chat by typing some of its name, folder, card or project. Before anything's typed it lists the chats
 * that need you first, then the rest, newest first, leaving out the one on screen.
 */
export function Switcher(props: { current: string | null; onClose: () => void }) {
  const id = createUniqueId()
  const [query, setQuery] = createSignal('')
  const [active, setActive] = createSignal(0)
  const items = createMemo(() => {
    const found = searchChats(query())
    if (found) return found.slice(0, MAX)
    const rest = sessions().filter((s) => !s.archived && !s.sideOf && s.id !== props.current)
    return [...rest.filter((s) => attention()[s.id]), ...rest.filter((s) => !attention()[s.id])].slice(0, MAX)
  })
  createEffect(on(query, () => setActive(0)))
  // Chats can go while it's open, leaving the highlight past the end.
  createEffect(on(items, (list) => active() >= list.length && setActive(Math.max(0, list.length - 1))))
  createEffect(on(active, (i) => document.getElementById(`${id}-${i}`)?.scrollIntoView({ block: 'nearest' })))

  const pick = (i: number) => {
    const s = items()[i]
    if (!s) return
    props.onClose()
    navigate({ kind: 'chat', id: s.id })
  }
  const onKey = (e: KeyboardEvent) => {
    const n = items().length
    const keys: Record<string, () => void> = {
      ArrowDown: () => n && setActive((i) => (i + 1) % n),
      ArrowUp: () => n && setActive((i) => (i - 1 + n) % n),
      Enter: () => !e.isComposing && pick(active()),
    }
    const action = keys[e.key]
    if (!action) return
    e.preventDefault()
    action()
  }

  return (
    <Dialog label="Switch chat" onClose={props.onClose} size="sm:h-auto sm:max-h-[min(36rem,80vh)] sm:max-w-xl">
      <input
        ref={(el) => queueMicrotask(() => el.focus())}
        value={query()}
        onInput={(e) => setQuery(e.currentTarget.value)}
        onKeyDown={onKey}
        placeholder="Go to a chat"
        role="combobox"
        aria-expanded="true"
        aria-controls={id}
        aria-activedescendant={items().length ? `${id}-${active()}` : undefined}
        class="h-11 shrink-0 border-b border-line bg-transparent px-3.5 text-ui outline-none placeholder:text-fg-3 pointer-coarse:text-base"
      />
      <div id={id} role="listbox" class="min-h-0 flex-1 overflow-y-auto p-1">
        <For each={items()} fallback={<p class="px-2.5 py-2 text-ui text-fg-3">No chats match.</p>}>
          {(s, i) => (
            <div
              id={`${id}-${i()}`}
              role="option"
              aria-selected={active() === i()}
              onPointerMove={() => setActive(i())}
              // Keeps focus in the search box.
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => pick(i())}
              class={`cursor-pointer rounded-lg px-2.5 py-1.5 pointer-coarse:py-2.5 ${active() === i() ? 'bg-surface' : ''}`}
            >
              <ChatSummary session={s} card={cardOf(s.id)} titleClass={active() === i() || attention()[s.id] ? 'text-fg' : s.archived ? 'text-fg-3' : 'text-fg-2'} />
            </div>
          )}
        </For>
      </div>
    </Dialog>
  )
}
