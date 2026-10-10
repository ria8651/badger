import { For, Show, createSignal } from 'solid-js'
import { GitBranch, ListChecks, MessageSquare, Plus } from 'lucide-solid'
import { descendants } from '../../shared/cardTree.ts'
import { CARD_STATUSES, type Card, type CardStatus, type SessionSummary } from '../../shared/protocol.ts'
import { api } from '../api.ts'
import { folderLabel, worktreeOf } from '../folders.ts'
import { ChatDot, inputClass } from './ui.tsx'
import { attention } from '../attention.ts'

export const STATUS_LABELS: Record<CardStatus, string> = {
  backlog: 'Backlog',
  todo: 'To do',
  in_progress: 'In progress',
  review: 'Review',
  done: 'Done',
}

/** Where a dragged card would land: before the card at `index` in the column, ignoring the dragged card itself. */
interface DropTarget {
  status: CardStatus
  index: number
}

type BoardProps = {
  /** Every card; each board shows the ones inside its parent. */
  cards: Card[]
  sessions: SessionSummary[]
  /** Optimistic local update; the server's cards_changed brings the truth. */
  setCards: (cards: Card[]) => void
  onOpen: (id: number) => void
}

/** The top-level board: projects, which are the cards that aren't inside another. */
export function Board(props: BoardProps) {
  return (
    <div class="flex h-full min-w-0 flex-1 flex-col">
      <div class="flex h-12 shrink-0 items-center px-5">
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

  const column = (status: CardStatus) => props.cards.filter((c) => (c.parentId ?? null) === props.parentId && c.status === status).sort((a, b) => a.position - b.position)
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
    props.setCards(props.cards.map((c) => (c.id === id ? { ...c, status: t.status, position } : c)))
    api.updateCard(id, { status: t.status, position })
  }

  const create = (status: CardStatus, title: string) => {
    if (!title.trim()) return setAdding(null)
    api.createCard({ title, status, parentId: props.parentId })
  }

  return (
    <div class={`flex gap-3 overflow-x-auto px-5 pb-5 ${props.class ?? ''}`}>
        <For each={CARD_STATUSES}>
          {(status) => (
            <section
              class="flex w-72 shrink-0 flex-col rounded-xl bg-surface/50"
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
                <span class="text-[13px] font-medium text-fg-2">{STATUS_LABELS[status]}</span>
                <span class="text-xs text-fg-3 tabular-nums">{column(status).length}</span>
                <button
                  onClick={() => setAdding(status)}
                  title="Add card"
                  class="ml-auto grid size-6 place-items-center rounded-md text-fg-3 transition-colors hover:bg-surface hover:text-fg"
                >
                  <Plus class="size-3.5" />
                </button>
              </header>
              <div class="flex min-h-16 flex-1 flex-col gap-1.5 overflow-y-auto px-2 pb-2">
                <For each={column(status)}>
                  {(card) => {
                    const chats = () => props.sessions.filter((s) => card.sessionIds.includes(s.id))
                    const inside = () => props.cards.filter((c) => c.parentId === card.id)
                    const done = () => inside().filter((c) => c.status === 'done').length
                    // Chats on the cards inside it count too, so a project shows when anything in it needs you.
                    const allIds = () => [card, ...descendants(props.cards, card.id)].flatMap((c) => c.sessionIds)
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
                          class={`rounded-lg border border-line bg-bg px-3 py-2.5 text-left transition-colors hover:border-edge ${
                            dragging() === card.id ? 'opacity-40' : ''
                          }`}
                        >
                          <div class="text-[13px] leading-snug text-fg">{card.title}</div>
                          <div class="mt-1.5 flex items-center gap-2 text-[11px] text-fg-3 tabular-nums">
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
                              running={props.sessions.some((s) => s.running && allIds().includes(s.id))}
                              attention={cardAttention()}
                            />
                          </div>
                        </button>
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
