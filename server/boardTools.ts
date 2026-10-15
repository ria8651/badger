import { createHash } from 'node:crypto'
import { z } from 'zod'
import { CARD_STATUSES, type Card } from '../shared/protocol.ts'
import { NO_CARD_CONTEXT, renderCardContext } from '../shared/cardContext.ts'
import { ancestors, descendants, projectOf } from '../shared/cardTree.ts'
import type { Actor, Store } from './db.ts'
import { OpError, op, type Op, type OpContext } from './ops.ts'

export const BOARD_SERVER = 'badger'

export const BOARD_INSTRUCTIONS = [
  "This chat runs inside Badger, which has a project board: cards are units of work, each with a status column and the chats working on it. Cards aren't tied to a repo; one card can hold chats in several repos.",
  "When this chat is on a card, the card's current state is added to the conversation whenever it changes. get_card with no id fetches it on demand.",
  'Top-level cards are projects. Each has its own board of cards, one per piece of work. When you find a follow-up or bug while working, add it as a card to the same project.',
  'Use these tools when the user talks about cards, the board, tasks or what to work on. Keep a card you are working on up to date: move its status as work progresses and write what you learn into its description.',
  `Statuses, in board order: ${CARD_STATUSES.join(', ')}.`,
  "Every Badger tool (these, the terminal ones and the preview ones) can also be called from code: run_script runs JavaScript in which they're `badger.cards.list(...)` and so on, returning data rather than text. Use it for bulk changes, or anything you'd otherwise do in many calls or that needs filtering.",
].join('\n')

const status = z.enum(CARD_STATUSES)

/**
 * The chat's card as context for the next turn, or undefined when Claude has
 * already seen this exact state. Appended to the turn rather than the system
 * prompt, so it never invalidates the prompt cache; it lands in the transcript
 * and survives resumes, and the stored hash stops it being repeated. Asking
 * doesn't count it as seen: `contextSeen` does, once it's gone in, so a reply
 * lost on the way can't lose it.
 */
export function cardContext(store: Store, sessionId: string): string | undefined {
  const cards = store.cards()
  const card = cards.find((c) => c.sessionIds.includes(sessionId))
  const last = store.contextHash(sessionId)
  if (!card) return last === undefined ? undefined : NO_CARD_CONTEXT
  const rendered = renderCardContext(card, ancestors(cards, card.id))
  return hashOf(rendered) === last ? undefined : rendered
}

/** Claude has been given this card context, so it isn't repeated. */
export function contextSeen(store: Store, sessionId: string, text: string): void {
  store.setContextHash(sessionId, text === NO_CARD_CONTEXT ? null : hashOf(text))
}

const hashOf = (text: string) => createHash('sha1').update(text).digest('hex')

const CARD = 'Card = { id, parentId, title, description, status, position, sessionIds, createdAt, updatedAt, statusChangedAt }'

/** A chat as the board describes it. */
export interface ChatInfo {
  id: string
  title?: string
  cwd?: string
  /** The machine it runs on, and what that's called. */
  machine?: string
  machineName?: string
}

export interface BoardDeps {
  store: Store
  /** Board data changed. */
  onChange: () => void
  /** What the hub knows of these chats, wherever they run. */
  chats: (ids: string[]) => Promise<ChatInfo[]>
}

/**
 * The project board. "This chat" is whichever chat calls: a tool's own, or
 * the one whose script it is. The board is the hub's; runners run these
 * there (ops.ts forwarded).
 */
export function boardOps({ store, onChange, chats }: BoardDeps): Op[] {
  const actor = (ctx: OpContext): Actor => ({ source: 'claude', sessionId: ctx.sessionId })
  const cardOf = (ctx: OpContext) => store.cards().find((c) => c.sessionIds.includes(ctx.sessionId))
  // Claude already knows this state (it wrote or just read it), so don't inject it next turn.
  const markSeen = (card: Card, ctx: OpContext) => {
    if (card.sessionIds.includes(ctx.sessionId)) store.setContextHash(ctx.sessionId, hashOf(renderCardContext(card, ancestors(store.cards(), card.id))))
  }
  const changed = <T>(value: T): T => {
    onChange()
    return value
  }
  const need = (id: number) => store.card(id) ?? fail(`No card #${id}.`)
  const s = { server: BOARD_SERVER }

  return [
    op({
      ...s,
      tool: 'list_cards',
      script: 'cards.list',
      description: 'List cards as a tree, each indented under the card it sits inside, in board order. Marks the card this chat belongs to.',
      input: {
        parent_id: z.number().int().optional().describe('Only the cards inside this one. Omit for every card'),
        status: status.optional().describe('Only cards in this column, plus the cards they sit inside'),
      },
      returns: `Card[], in the tree's order. ${CARD}`,
      autoAllow: true,
      annotations: { readOnlyHint: true },
      async run(args, ctx) {
        const all = store.cards()
        if (args.parent_id !== undefined) need(args.parent_id)
        const listed = tree(all, args.parent_id ?? null, args.status)
        const mine = cardOf(ctx)?.id
        const lines = listed.map(({ card, depth }) => '  '.repeat(depth) + summary(card, card.id === mine, all))
        return { text: lines.length ? lines.join('\n') : 'No cards.', value: listed.map((l) => l.card) }
      },
    }),
    op({
      ...s,
      tool: 'get_card',
      script: 'cards.get',
      description: "Get a card's full description and its chats. Omit id for the card this chat belongs to.",
      input: { id: z.number().int().optional() },
      returns: 'Card & { chats: { id, title, cwd?, machine?, archived, thisChat }[], inside: Card[] }',
      autoAllow: true,
      annotations: { readOnlyHint: true },
      async run(args, ctx) {
        const card = args.id === undefined ? (cardOf(ctx) ?? fail('This chat is not on a card.')) : need(args.id)
        markSeen(card, ctx)
        return detail(card, store.cards(), ctx.sessionId, store.archivedIds(), await chats([...card.sessionIds, ctx.sessionId]))
      },
    }),
    op({
      ...s,
      tool: 'create_card',
      script: 'cards.create',
      description: 'Create a card. It goes to the bottom of its column.',
      input: {
        title: z.string().min(1),
        parent_id: z
          .number()
          .int()
          .nullable()
          .optional()
          .describe("The project to put it in. Defaults to the project this chat's card is in; null makes it a new project"),
        description: z.string().optional().describe('Markdown'),
        status: status.optional().describe('Defaults to backlog'),
        link_this_chat: z.boolean().optional().describe('Also put this chat on the new card'),
      },
      returns: 'Card',
      autoAllow: true,
      async run(args, ctx) {
        const mine = cardOf(ctx)
        const parentId = args.parent_id !== undefined ? args.parent_id : ((mine && projectOf(store.cards(), mine.id)?.id) ?? null)
        const card = store.createCard({ ...args, parentId }, actor(ctx))
        if (args.link_this_chat) store.linkSession(card.id, ctx.sessionId, actor(ctx))
        const created = store.card(card.id)!
        markSeen(created, ctx)
        const where = parentId === null ? ' as a new project' : ` in project #${parentId}`
        return changed({ text: `Created ${summary(created, !!args.link_this_chat)}${where}`, value: created })
      },
    }),
    op({
      ...s,
      tool: 'update_card',
      script: 'cards.update',
      description: "Change a card's title, description, status or parent. Description replaces the whole text, so read it first with get_card.",
      input: {
        id: z.number().int(),
        parent_id: z.number().int().nullable().optional().describe('Move it into this project, or null to make it a project'),
        title: z.string().min(1).optional(),
        description: z.string().optional().describe('Markdown; replaces the existing description'),
        status: status.optional(),
      },
      returns: 'Card',
      autoAllow: true,
      annotations: { idempotentHint: true },
      async run({ id, parent_id, ...patch }, ctx) {
        const card = store.updateCard(id, { ...patch, parentId: parent_id }, actor(ctx)) ?? fail(`No card #${id}.`)
        markSeen(card, ctx)
        return changed({ text: `Updated ${summary(card, card.id === cardOf(ctx)?.id)}`, value: card })
      },
    }),
    op({
      ...s,
      tool: 'link_chat',
      script: 'cards.link',
      description: 'Put this chat on a card, moving it off any card it was on.',
      input: { id: z.number().int() },
      returns: 'Card',
      autoAllow: true,
      annotations: { idempotentHint: true },
      async run({ id }, ctx) {
        need(id)
        store.linkSession(id, ctx.sessionId, actor(ctx))
        return changed({ text: `This chat is now on card #${id}.`, value: store.card(id) })
      },
    }),
    op({
      ...s,
      tool: 'archive_chat',
      script: 'chats.archive',
      description:
        "Hide a chat from Badger's sidebar, or bring it back. Its transcript is kept; sending it a message unarchives it. Moving a card to done archives its chats, so there's no need to archive them separately.",
      input: {
        session_id: z
          .string()
          .regex(/^[0-9a-f-]{36}$/)
          .optional()
          .describe('Chat id, as listed by get_card. Omit for this chat'),
        archived: z.boolean().optional().describe('false to unarchive. Defaults to true'),
      },
      returns: '{ sessionId, archived }',
      autoAllow: true,
      annotations: { idempotentHint: true },
      async run(args, ctx) {
        const id = args.session_id ?? ctx.sessionId
        const archived = args.archived ?? true
        store.setArchived(id, archived, actor(ctx))
        const which = id === ctx.sessionId ? 'This chat' : `Chat ${id}`
        return { text: `${which} is ${archived ? 'archived' : 'not archived'}.`, value: { sessionId: id, archived } }
      },
    }),
    op({
      ...s,
      tool: 'delete_card',
      script: 'cards.delete',
      description: 'Delete a card and every card inside it. Their chats are kept. Only do this when the user asks.',
      input: { id: z.number().int() },
      returns: '{ deleted: id }',
      annotations: { destructiveHint: true },
      async run({ id }, ctx) {
        if (!store.deleteCard(id, actor(ctx))) fail(`No card #${id}.`)
        return changed({ text: `Deleted card #${id}.`, value: { deleted: id } })
      },
    }),
  ]
}

const fail = (message: string): never => {
  throw new OpError(message)
}

function summary(c: Card, mine: boolean, cards: Card[] = []): string {
  const chats = c.sessionIds.length ? `, ${c.sessionIds.length} chat${c.sessionIds.length === 1 ? '' : 's'}` : ''
  const inside = cards.filter((d) => d.parentId === c.id)
  const done = inside.filter((d) => d.status === 'done').length
  const progress = inside.length ? `, ${done}/${inside.length} cards done` : ''
  return `#${c.id} [${c.status}] ${c.title}${chats}${progress}${mine ? ' (this chat)' : ''}`
}

/** Cards inside `parent` (null for all), depth-first, keeping only those in `status` and the cards above them. */
function tree(cards: Card[], parent: number | null, status?: Card['status']): { card: Card; depth: number }[] {
  const out: { card: Card; depth: number }[] = []
  const walk = (parentId: number | null, depth: number) => {
    for (const c of cards.filter((c) => c.parentId === parentId).sort(boardOrder)) {
      const matches = !status || c.status === status || descendants(cards, c.id).some((d) => d.status === status)
      if (!matches) continue
      out.push({ card: c, depth })
      walk(c.id, depth + 1)
    }
  }
  walk(parent, 0)
  return out
}

const boardOrder = (a: Card, b: Card) => CARD_STATUSES.indexOf(a.status) - CARD_STATUSES.indexOf(b.status) || a.position - b.position

/** A card in full. Chats on another machine than the caller's say which. */
function detail(c: Card, cards: Card[], sessionId: string, archived: Set<string>, infos: ChatInfo[]) {
  const mine = infos.find((i) => i.id === sessionId)?.machine
  const chats = c.sessionIds.flatMap((id) => {
    const info = infos.find((i) => i.id === id)
    if (!info?.title && id !== sessionId) return []
    return [{ id, title: info?.title || 'New chat', cwd: info?.cwd, machine: info?.machine, archived: archived.has(id), thisChat: id === sessionId }]
  })
  const lines = chats.map((chat) => {
    const info = infos.find((i) => i.id === chat.id)
    const elsewhere = chat.machine && chat.machine !== mine ? ` on ${info?.machineName ?? chat.machine}` : ''
    const notes = [chat.cwd && `in ${chat.cwd}${elsewhere}`, chat.archived && 'archived', chat.thisChat && 'this chat'].filter(Boolean)
    return `- ${chat.title} [${chat.id}]${notes.length ? ` (${notes.join(', ')})` : ''}`
  })
  const path = ancestors(cards, c.id)
  const inside = tree(cards, c.id)
  const text = [
    `#${c.id} ${c.title}`,
    `Status: ${c.status}`,
    ...(path.length ? [`Inside: ${path.map((p) => `#${p.id} ${p.title}`).join(' > ')}`] : []),
    '',
    c.description.trim() || '(no description)',
    '',
    lines.length ? `Chats:\n${lines.join('\n')}` : 'No chats.',
    ...(inside.length ? ['', `Cards inside it:\n${inside.map(({ card, depth }) => '  '.repeat(depth) + summary(card, false, cards)).join('\n')}`] : []),
  ].join('\n')
  return { text, value: { ...c, chats, inside: inside.map((i) => i.card) } }
}
