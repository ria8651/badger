import { createMemo, createRoot, createSignal } from 'solid-js'
import { createStore, produce, reconcile } from 'solid-js/store'
import { projectOf as projectIn } from '../../shared/cardTree.ts'
import type { Card, CardStatus } from '../../shared/protocol.ts'
import { api, socket } from '../api.ts'
import { configReady } from './config.ts'

export const STATUS_LABELS: Record<CardStatus, string> = {
  backlog: 'Backlog',
  todo: 'To do',
  in_progress: 'In progress',
  review: 'Review',
  done: 'Done',
}

/**
 * Every card on the board, kept current over the socket. Reconciled by id, so a refresh updates cards in place
 * instead of rebuilding them mid-drag or mid-edit. Changes made here show at once; if the server refuses one,
 * the cards are fetched again and the error passed on.
 */
const [list, setList] = createStore<Card[]>([])
export const cards = () => list
/** False until the cards have arrived. */
const [loaded, setLoaded] = createSignal(false)
export const cardsLoaded = loaded

const refresh = () =>
  api.cards().then((next) => {
    setList(reconcile(next, { key: 'id' }))
    setLoaded(true)
  })

socket.onConnection((connected) => connected && void configReady.then(refresh).catch(() => {}))
socket.on((e) => e.type === 'cards_changed' && void refresh().catch(() => {}))

export const cardById = (id: number) => list.find((c) => c.id === id)

const byChat = createRoot(() => createMemo(() => new Map(list.flatMap((c) => c.sessionIds.map((id) => [id, c] as const)))))
/** The card a chat is on, if it's on one. */
export const cardOf = (sessionId: string) => byChat().get(sessionId)

/** The project a card is in: its top-level ancestor, or itself. */
export const projectOf = (cardId: number) => projectIn(list, cardId)

/** The project a chat is in, through its card. */
export const projectOfChat = (sessionId: string) => {
  const card = cardOf(sessionId)
  return card && projectOf(card.id)
}

/** Projects are the top-level cards. */
export const projects = () => list.filter((c) => (c.parentId ?? null) === null)

async function change<T>(local: (cards: Card[]) => void, remote: () => Promise<T>): Promise<T> {
  setList(produce(local))
  try {
    return await remote()
  } catch (e) {
    void refresh().catch(() => {})
    throw e
  }
}

type CardPatch = Partial<Pick<Card, 'title' | 'description' | 'status' | 'position' | 'parentId'>>

export const updateCard = (id: number, patch: CardPatch) =>
  change(
    (all) => Object.assign(all.find((c) => c.id === id) ?? {}, patch),
    () => api.updateCard(id, patch),
  )

/** Waits for the server, which numbers it. */
export const createCard = (card: { title: string; description?: string; status?: CardStatus; parentId?: number | null }) => api.createCard(card)

export const deleteCard = (id: number) => api.deleteCard(id)

/** Puts a chat on a card, taking it off any other: a chat is on one card at most. */
export const linkSession = (cardId: number, sessionId: string) =>
  change(
    (all) => {
      for (const c of all) {
        if (c.id === cardId && !c.sessionIds.includes(sessionId)) c.sessionIds.push(sessionId)
        else if (c.id !== cardId && c.sessionIds.includes(sessionId)) c.sessionIds = c.sessionIds.filter((s) => s !== sessionId)
      }
    },
    () => api.linkSession(cardId, sessionId),
  )

export const unlinkSession = (cardId: number, sessionId: string) =>
  change(
    (all) => {
      const c = all.find((c) => c.id === cardId)
      if (c) c.sessionIds = c.sessionIds.filter((s) => s !== sessionId)
    },
    () => api.unlinkSession(cardId, sessionId),
  )
