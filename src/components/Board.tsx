import { For, Show, createSignal } from 'solid-js'
import { ArrowLeftRight, GitBranch, ListChecks, MessageSquare, Plus } from '../icons'
import { descendants } from '../../shared/cardTree.ts'
import { CARD_STATUSES, type CardStatus } from '../../shared/protocol.ts'
import { folderLabel, worktreeOf } from '../folders.ts'
import { ChatDot, inputClass } from './ui.tsx'
import { attention } from '../attention.ts'
import { STATUS_LABELS, cards, createCard, updateCard } from '../stores/cards.ts'
import { sessions } from '../stores/sessions.ts'

/** Where a dragged card would land: before the card at `index` in the column, ignoring the dragged card itself. */
interface DropTarget {
  status: CardStatus
  index: number
}

type BoardProps = {
  /** Every card; each board shows the ones inside its parent. */
  onOpen: (id: number) => void
}

/** The top-level board: projects, which are the cards that aren't inside another. */
export function Board(props: BoardProps) {
  return (
    <div class="flex h-full min-w-0 flex-1 flex-col">
      <div class="bar relative z-10 flex h-12 shrink-0 items-center px-5 shadow-(--shadow-bar)">
        <h1 class="font-medium">Projects</h1>
      </div>
      <Columns {...props} parentId={null} class="flex-1" />
    </div>
  )
}

/** One board's status columns: the cards inside `parentId`, or the top level for null. */
export function Columns(props: BoardProps & { parentId: number | null; class?: string }) {
  const [dragging, setDragging] = createSignal<number | null>(null)
  const [target, setTarget] = createSignal<DropTarget | null>(null)
  const [adding, setAdding] = createSignal<CardStatus | null>(null)

  const column = (status: CardStatus) => cards().filter((c) => (c.parentId ?? null) === props.parentId && c.status === status).sort((a, b) => a.position - b.position)
  const others = (status: CardStatus) => column(status).filter((c) => c.id !== dragging())

  const drop = () => {
    const id = dragging()
    const t = target()
    setDragging(null)
    setTarget(null)
    if (id === null || !t) return
    const list = others(t.status)
    const prev = list[t.index - 1]?.position
    const next = list[t.index]?.position
    const position = prev === undefined ? (next === undefined ? 1 : next - 1) : next === undefined ? prev + 1 : (prev + next) / 2
    void updateCard(id, { status: t.status, position })
  }

  /** Without dragging, as on touch screens: to the bottom of another column. */
  const move = (id: number, status: CardStatus) => {
    const position = Math.max(0, ...column(status).map((c) => c.position)) + 1
    void updateCard(id, { status, position })
  }

  const create = (status: CardStatus, title: string) => {
    if (!title.trim()) return setAdding(null)
    void createCard({ title, status, parentId: props.parentId })
  }

  return (
    // Columns snap into place when swiped, since a phone shows about one at a time.
    <div class={`flex snap-x snap-mandatory scroll-px-5 gap-3 overflow-x-auto px-5 pb-5 md:snap-none ${props.class ?? ''}`}>
        <For each={CARD_STATUSES}>
          {(status) => (
            <section
              class="flex w-72 shrink-0 snap-start flex-col rounded-xl bg-surface/50"
              onDragOver={(e) => {
                if (dragging() === null) return
                e.preventDefault()
                // Only reached over empty space below the cards; cards stop propagation.
                setTarget({ status, index: others(status).length })
              }}
              onDrop={(e) => {
                e.preventDefault()
                drop()
              }}
            >
              <header class="flex h-10 shrink-0 items-center gap-2 px-3">
                <span class="text-ui font-medium text-fg-2">{STATUS_LABELS[status]}</span>
                <span class="text-xs text-fg-3 tabular-nums">{column(status).length}</span>
                <button
                  onClick={() => setAdding(status)}
                  title="Add card"
                  class="ml-auto grid size-6 place-items-center rounded-button-md text-fg-3 transition-colors hover:bg-surface hover:text-fg pointer-coarse:size-9"
                >
                  <Plus class="size-3.5" />
                </button>
              </header>
              <div
                class="flex min-h-16 flex-1 flex-col gap-1.5 overflow-y-auto px-2 pb-2"
                // Double-clicking empty space below the cards adds one, like the + button.
                onDblClick={(e) => e.target === e.currentTarget && setAdding(status)}
              >
                <For each={column(status)}>
                  {(card) => {
                    const chats = () => sessions().filter((s) => card.sessionIds.includes(s.id))
                    const inside = () => cards().filter((c) => c.parentId === card.id)
                    const done = () => inside().filter((c) => c.status === 'done').length
                    // Chats on the cards inside it count too, so a project shows when anything in it needs you.
                    const allIds = () => [card, ...descendants(cards(), card.id)].flatMap((c) => c.sessionIds)
                    // The most urgent of its chats'.
                    const cardAttention = () => {
                      const states = allIds().map((id) => attention()[id])
                      return states.includes('waiting') ? 'waiting' : states.includes('unread') ? 'unread' : undefined
                    }
                    const worktrees = () => [...new Set(chats().flatMap((s) => (s.cwd && !s.gone && worktreeOf(s.cwd) ? [s.cwd] : [])))]
                    return (
                      <>
                        <Show when={isTarget(status, card.id)}>
                          <DropLine />
                        </Show>
                        <div class="relative">
                          <button
                            draggable="true"
                            onDragStart={(e) => {
                              e.dataTransfer!.effectAllowed = 'move'
                              setDragging(card.id)
                            }}
                            onDragEnd={() => {
                              setDragging(null)
                              setTarget(null)
                            }}
                            onDragOver={(e) => {
                              if (dragging() === null) return
                              e.preventDefault()
                              e.stopPropagation()
                              if (card.id === dragging()) return
                              const rect = e.currentTarget.getBoundingClientRect()
                              const index = others(status).findIndex((c) => c.id === card.id)
                              setTarget({ status, index: e.clientY > rect.top + rect.height / 2 ? index + 1 : index })
                            }}
                            onClick={() => props.onOpen(card.id)}
                            class={`w-full rounded-lg border border-line bg-bg shadow-(--shadow-card) px-3 py-2.5 text-left transition-colors hover:border-edge ${
                              dragging() === card.id ? 'opacity-40' : ''
                            }`}
                          >
                            <div class="text-ui leading-snug text-fg">{card.title}</div>
                            <div class="mt-1.5 flex items-center gap-2 text-meta text-fg-3 tabular-nums pointer-coarse:mr-9">
                              <span>#{card.id}</span>
                              <Show when={chats().length}>
                                <span class="flex items-center gap-1">
                                  <MessageSquare class="size-3" />
                                  {chats().length}
                                </span>
                              </Show>
                              <Show when={inside().length}>
                                <span title="Cards inside it that are done" class="flex items-center gap-1">
                                  <ListChecks class="size-3" />
                                  {done()}/{inside().length}
                                </span>
                              </Show>
                              <Show when={worktrees().length}>
                                <span title={worktrees().map(folderLabel).join('\n')} class="flex items-center">
                                  <GitBranch class="size-3" />
                                </span>
                              </Show>
                              <ChatDot
                                class="ml-auto"
                                running={sessions().some((s) => s.running && allIds().includes(s.id))}
                                attention={cardAttention()}
                              />
                            </div>
                          </button>
                          {/* Dragging is unreliable on touch, so there a card moves with the system's own picker. */}
                          <label class="absolute right-0.5 bottom-0.5 hidden size-9 place-items-center rounded-md text-fg-3 pointer-coarse:grid">
                            <ArrowLeftRight class="size-3.5" />
                            <select
                              value={status}
                              onChange={(e) => move(card.id, e.currentTarget.value as CardStatus)}
                              aria-label="Move to"
                              class="absolute inset-0 text-base opacity-0"
                            >
                              <For each={CARD_STATUSES}>{(s) => <option value={s}>{STATUS_LABELS[s]}</option>}</For>
                            </select>
                          </label>
                        </div>
                      </>
                    )
                  }}
                </For>
                <Show when={target()?.status === status && target()!.index === others(status).length}>
                  <DropLine />
                </Show>
                <Show when={adding() === status}>
                  <input
                    ref={(el) => queueMicrotask(() => el.focus())}
                    placeholder="Card title"
                    class={`${inputClass} bg-bg`}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.isComposing) {
                        create(status, e.currentTarget.value)
                        e.currentTarget.value = ''
                      }
                      if (e.key === 'Escape') {
                        e.currentTarget.value = ''
                        setAdding(null)
                      }
                    }}
                    onBlur={(e) => {
                      create(status, e.currentTarget.value)
                      setAdding(null)
                    }}
                  />
                </Show>
              </div>
            </section>
          )}
        </For>
    </div>
  )

  function isTarget(status: CardStatus, cardId: number): boolean {
    const t = target()
    if (!t || t.status !== status || cardId === dragging()) return false
    return others(status)[t.index]?.id === cardId
  }
}

function DropLine() {
  return <div class="-my-1 h-0.5 shrink-0 rounded-full bg-fg-3" />
}
