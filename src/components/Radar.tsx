import { For, Show, createMemo, type JSX } from 'solid-js'
import { projectOf } from '../../shared/cardTree.ts'
import type { Card, SessionSummary } from '../../shared/protocol.ts'
import { attention } from '../attention.ts'
import { STATUS_LABELS } from './Board.tsx'
import { ChatDot } from './ui.tsx'

const DAY = 24 * 60 * 60 * 1000
/** In progress with no chat activity for this long is flagged. */
const STALE_AFTER = 3 * DAY
const UP_NEXT_PER_PROJECT = 3

/**
 * Everything on your radar across projects, with nothing to set up: what's waiting on you, what's in flight,
 * what's next in each project and what got done. Everything is yours until there are users.
 */
export function Radar(props: {
  cards: Card[]
  sessions: SessionSummary[]
  onOpenCard: (id: number) => void
  onOpenChat: (id: string) => void
}) {
  const cardOf = createMemo(() => new Map(props.cards.flatMap((c) => c.sessionIds.map((id) => [id, c] as const))))
  const projectTitle = (c: Card) => (c.parentId === null ? undefined : projectOf(props.cards, c.id)?.title)
  /** When a card was last worked on: its latest chat, or when it last changed column. */
  const lastActive = (c: Card) => Math.max(c.statusChangedAt, ...props.sessions.filter((s) => c.sessionIds.includes(s.id)).map((s) => s.lastModified))
  const chatsOf = (c: Card) => props.sessions.filter((s) => c.sessionIds.includes(s.id))

  const needsYou = createMemo(() => props.sessions.filter((s) => !s.archived && attention()[s.id]).sort((a, b) => b.lastModified - a.lastModified))
  // Projects are containers, so only the work inside them counts as in flight.
  const work = createMemo(() => props.cards.filter((c) => c.parentId !== null))
  const inFlight = createMemo(() =>
    work()
      .filter((c) => c.status === 'in_progress' || c.status === 'review')
      .sort((a, b) => lastActive(b) - lastActive(a)),
  )
  const upNext = createMemo(() =>
    props.cards
      .filter((p) => p.parentId === null && p.status !== 'done')
      .flatMap((p) => {
        const inside = props.cards.filter((c) => c.parentId === p.id).sort((a, b) => a.position - b.position)
        const todo = inside.filter((c) => c.status === 'todo')
        return (todo.length ? todo : inside.filter((c) => c.status === 'backlog')).slice(0, UP_NEXT_PER_PROJECT)
      }),
  )
  const done = createMemo(() =>
    work()
      .filter((c) => c.status === 'done' && Date.now() - c.statusChangedAt < 7 * DAY)
      .sort((a, b) => b.statusChangedAt - a.statusChangedAt),
  )

  const cardRow = (c: Card, note?: JSX.Element) => {
    const chats = chatsOf(c)
    const states = chats.map((s) => attention()[s.id])
    return (
      <Row
        onClick={() => props.onOpenCard(c.id)}
        title={c.title}
        project={projectTitle(c)}
        dot={<ChatDot running={chats.some((s) => s.running)} attention={states.includes('waiting') ? 'waiting' : states.includes('unread') ? 'unread' : undefined} />}
        note={note ?? <span>{STATUS_LABELS[c.status]}</span>}
      />
    )
  }

  return (
    <div class="flex h-full min-w-0 flex-1 flex-col overflow-y-auto">
      <div class="flex h-12 shrink-0 items-center px-5">
        <h1 class="font-medium">Radar</h1>
      </div>
      <div class="mx-auto w-full max-w-3xl px-5 pb-10">
        <Section title="Needs you" count={needsYou().length} empty="Nothing is waiting on you.">
          <For each={needsYou()}>
            {(s) => {
              const card = () => cardOf().get(s.id)
              return (
                <Row
                  onClick={() => props.onOpenChat(s.id)}
                  title={s.title}
                  project={card() ? (projectOf(props.cards, card()!.id)?.title ?? undefined) : undefined}
                  dot={<ChatDot running={s.running} attention={attention()[s.id]} />}
                  note={<span>{attention()[s.id] === 'waiting' ? 'Waiting on you' : 'Finished'}</span>}
                />
              )
            }}
          </For>
        </Section>

        <Section title="In flight" count={inFlight().length} empty="Nothing in progress or in review.">
          <For each={inFlight()}>
            {(c) => {
              const idle = Date.now() - lastActive(c)
              return cardRow(
                c,
                <span class={idle > STALE_AFTER ? 'text-fg-2' : ''} title={idle > STALE_AFTER ? 'No activity for a while' : undefined}>
                  {STATUS_LABELS[c.status]} · {idle > STALE_AFTER ? 'idle ' : ''}
                  {ago(lastActive(c))}
                </span>,
              )
            }}
          </For>
        </Section>

        <Section title="Up next" count={upNext().length} empty="No projects with cards waiting. Add cards to a project's board.">
          <For each={upNext()}>{(c) => cardRow(c)}</For>
        </Section>

        <Section title="Done this week" count={done().length} empty="Nothing finished in the last 7 days.">
          <For each={done()}>{(c) => cardRow(c, <span>{ago(c.statusChangedAt)}</span>)}</For>
        </Section>
      </div>
    </div>
  )
}

function Section(props: { title: string; count: number; empty: string; children: JSX.Element }) {
  return (
    <section class="mt-6">
      <h2 class="flex items-baseline gap-2 border-b border-line pb-2 text-[13px] font-medium text-fg-2">
        {props.title}
        <span class="text-xs font-normal text-fg-3 tabular-nums">{props.count}</span>
      </h2>
      <Show when={props.count} fallback={<p class="py-3 text-[13px] text-fg-3">{props.empty}</p>}>
        {props.children}
      </Show>
    </section>
  )
}

function Row(props: { onClick: () => void; title: string; project?: string; dot: JSX.Element; note: JSX.Element }) {
  return (
    <button onClick={props.onClick} class="group -mx-2 flex w-[calc(100%+1rem)] items-center gap-3 rounded-lg px-2 py-2.5 text-left transition-colors hover:bg-surface/60">
      <span class="min-w-0 flex-1 truncate text-[13px] text-fg-2 group-hover:text-fg">{props.title}</span>
      <Show when={props.project}>
        <span class="max-w-40 shrink-0 truncate text-[11px] text-fg-3">{props.project}</span>
      </Show>
      {props.dot}
      <span class="w-36 shrink-0 text-right text-[11px] text-fg-3 tabular-nums">{props.note}</span>
    </button>
  )
}

function ago(ms: number): string {
  const d = Date.now() - ms
  if (d < 60 * 60 * 1000) return `${Math.max(1, Math.round(d / 60000))}m ago`
  if (d < DAY) return `${Math.round(d / 3600000)}h ago`
  return `${Math.round(d / DAY)}d ago`
}
