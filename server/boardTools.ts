import { createHash } from 'node:crypto'
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { CARD_STATUSES, type Card } from '../shared/protocol.ts'
import { NO_CARD_CONTEXT, renderCardContext } from '../shared/cardContext.ts'
import { ancestors, descendants, projectOf } from '../shared/cardTree.ts'
import type { Actor, Store } from './db.ts'
import type { Remote } from './peer.ts'
import type { Board, ChatInfo } from './runnerProtocol.ts'

export const BOARD_SERVER = 'badger'

/** Tools that only read, or write without destroying anything. Anything else goes through the normal permission flow. */
export const BOARD_AUTO_ALLOWED = ['list_cards', 'get_card', 'create_card', 'update_card', 'link_chat', 'archive_chat'].map(
  (t) => `mcp__${BOARD_SERVER}__${t}`,
)

const status = z.enum(CARD_STATUSES)

/**
 * The chat's card as context for the next turn, or undefined when Claude has
 * already seen this exact state. Appended to the turn rather than the system
 * prompt, so it never invalidates the prompt cache; it lands in the transcript
 * and survives resumes, and the stored hash stops it being repeated.
 */
export function cardContext(store: Store, sessionId: string): string | undefined {
  const cards = store.cards()
  const card = cards.find((c) => c.sessionIds.includes(sessionId))
  const last = store.contextHash(sessionId)
  if (!card) {
    if (last === undefined) return undefined
    store.setContextHash(sessionId, null)
    return NO_CARD_CONTEXT
  }
  const rendered = renderCardContext(card, ancestors(cards, card.id))
  const hash = hashOf(rendered)
  if (hash === last) return undefined
  store.setContextHash(sessionId, hash)
  return rendered
}

/** Claude has just read or written this card, so it already knows this state: don't add it to the next turn. */
export function markSeen(store: Store, sessionId: string, cardId: number): void {
  const cards = store.cards()
  const card = cards.find((c) => c.id === cardId)
  if (card?.sessionIds.includes(sessionId)) store.setContextHash(sessionId, hashOf(renderCardContext(card, ancestors(cards, card.id))))
}

const hashOf = (text: string) => createHash('sha1').update(text).digest('hex')

/**
 * The project board as tools, for one chat. A new instance per Claude Code
 * process: it knows which chat it is so "this chat" means something. The
 * tools run beside Claude Code on its machine; the board is the hub's.
 * `machine` is this one's id, so chats elsewhere can say where they are.
 * `more` are other Badger tools that go on the same server, e.g. merging a worktree.
 */
export function boardServer(
  board: Remote<Board>,
  sessionId: string,
  machine: () => string,
  more: SdkMcpToolDefinition<any>[] = [],
): McpSdkServerConfigWithInstance {
  const actor: Actor = { source: 'claude', sessionId }
  const thisCard = async () => (await board.cards()).find((c) => c.sessionIds.includes(sessionId))
  const markSeen = (card: Card) => board.markSeen(sessionId, card.id)

  return createSdkMcpServer({
    name: BOARD_SERVER,
    alwaysLoad: true,
    instructions: [
      "This chat runs inside Badger, which has a project board: cards are units of work, each with a status column and the chats working on it. Cards aren't tied to a repo; one card can hold chats in several repos.",
      "When this chat is on a card, the card's current state is added to the conversation whenever it changes. get_card with no id fetches it on demand.",
      'Top-level cards are projects. Each has its own board of cards, one per piece of work. When you find a follow-up or bug while working, add it as a card to the same project.',
      'Use these tools when the user talks about cards, the board, tasks or what to work on. Keep a card you are working on up to date: move its status as work progresses and write what you learn into its description.',
      `Statuses, in board order: ${CARD_STATUSES.join(', ')}.`,
    ].join('\n'),
    tools: [
      tool(
        'list_cards',
        'List cards as a tree, each indented under the card it sits inside, in board order. Marks the card this chat belongs to.',
        {
          parent_id: z.number().int().optional().describe('Only the cards inside this one. Omit for every card'),
          status: status.optional().describe('Only cards in this column, plus the cards they sit inside'),
        },
        async (args) => {
          const all = await board.cards()
          if (args.parent_id !== undefined && !all.some((c) => c.id === args.parent_id)) return error(`No card #${args.parent_id}.`)
          const mine = all.find((c) => c.sessionIds.includes(sessionId))?.id
          const lines = tree(all, args.parent_id ?? null, args.status, mine)
          return text(lines.length ? lines.join('\n') : 'No cards.')
        },
        { annotations: { readOnlyHint: true } },
      ),
      tool(
        'get_card',
        "Get a card's full description and its chats. Omit id for the card this chat belongs to.",
        { id: z.number().int().optional() },
        async (args) => {
          const card = args.id === undefined ? await thisCard() : await board.card(args.id)
          if (!card) return error(args.id === undefined ? 'This chat is not on a card.' : `No card #${args.id}.`)
          const [cards, archived, chats] = await Promise.all([board.cards(), board.archivedIds(), board.chatInfo(card.sessionIds)])
          await markSeen(card)
          return text(detail(card, cards, sessionId, new Set(archived), chats, machine()))
        },
        { annotations: { readOnlyHint: true } },
      ),
      tool(
        'create_card',
        'Create a card. It goes to the bottom of its column.',
        {
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
        async (args) => {
          const cards = await board.cards()
          const mine = cards.find((c) => c.sessionIds.includes(sessionId))
          const parentId = args.parent_id !== undefined ? args.parent_id : ((mine && projectOf(cards, mine.id)?.id) ?? null)
          const card = await board.createCard({ ...args, parentId }, actor)
          if (args.link_this_chat) await board.linkSession(card.id, sessionId, actor)
          const created = (await board.card(card.id))!
          await markSeen(created)
          const where = parentId === null ? ' as a new project' : ` in project #${parentId}`
          return text(`Created ${summary(created, !!args.link_this_chat)}${where}`)
        },
      ),
      tool(
        'update_card',
        "Change a card's title, description, status or parent. Description replaces the whole text, so read it first with get_card.",
        {
          id: z.number().int(),
          parent_id: z.number().int().nullable().optional().describe('Move it into this project, or null to make it a project'),
          title: z.string().min(1).optional(),
          description: z.string().optional().describe('Markdown; replaces the existing description'),
          status: status.optional(),
        },
        async ({ id, parent_id, ...patch }) => {
          const card = await board.updateCard(id, { ...patch, parentId: parent_id }, actor)
          if (!card) return error(`No card #${id}.`)
          await markSeen(card)
          return text(`Updated ${summary(card, card.sessionIds.includes(sessionId))}`)
        },
        { annotations: { idempotentHint: true } },
      ),
      tool(
        'link_chat',
        'Put this chat on a card, moving it off any card it was on.',
        { id: z.number().int() },
        async ({ id }) => {
          if (!(await board.card(id))) return error(`No card #${id}.`)
          await board.linkSession(id, sessionId, actor)
          return text(`This chat is now on card #${id}.`)
        },
        { annotations: { idempotentHint: true } },
      ),
      tool(
        'archive_chat',
        "Hide a chat from Badger's sidebar, or bring it back. Its transcript is kept; sending it a message unarchives it. Moving a card to done archives its chats, so there's no need to archive them separately.",
        {
          session_id: z
            .string()
            .regex(/^[0-9a-f-]{36}$/)
            .optional()
            .describe('Chat id, as listed by get_card. Omit for this chat'),
          archived: z.boolean().optional().describe('false to unarchive. Defaults to true'),
        },
        async (args) => {
          const id = args.session_id ?? sessionId
          const archived = args.archived ?? true
          await board.setArchived(id, archived, actor)
          const which = id === sessionId ? 'This chat' : `Chat ${id}`
          return text(`${which} is ${archived ? 'archived' : 'not archived'}.`)
        },
        { annotations: { idempotentHint: true } },
      ),
      tool(
        'delete_card',
        'Delete a card and every card inside it. Their chats are kept. Only do this when the user asks.',
        { id: z.number().int() },
        async ({ id }) => ((await board.deleteCard(id, actor)) ? text(`Deleted card #${id}.`) : error(`No card #${id}.`)),
        { annotations: { destructiveHint: true } },
      ),
      ...more,
    ],
  })
}


function summary(c: Card, mine: boolean, cards: Card[] = []): string {
  const chats = c.sessionIds.length ? `, ${c.sessionIds.length} chat${c.sessionIds.length === 1 ? '' : 's'}` : ''
  const inside = cards.filter((d) => d.parentId === c.id)
  const done = inside.filter((d) => d.status === 'done').length
  const progress = inside.length ? `, ${done}/${inside.length} cards done` : ''
  return `#${c.id} [${c.status}] ${c.title}${chats}${progress}${mine ? ' (this chat)' : ''}`
}

/** Cards inside `parent` (null for all), depth-first and indented, keeping only those in `status` and the cards above them. */
function tree(cards: Card[], parent: number | null, status: Card['status'] | undefined, mine: number | undefined): string[] {
  const lines: string[] = []
  const walk = (parentId: number | null, depth: number) => {
    for (const c of cards.filter((c) => c.parentId === parentId).sort(boardOrder)) {
      const matches = !status || c.status === status || descendants(cards, c.id).some((d) => d.status === status)
      if (!matches) continue
      lines.push('  '.repeat(depth) + summary(c, c.id === mine, cards))
      walk(c.id, depth + 1)
    }
  }
  walk(parent, 0)
  return lines
}

const boardOrder = (a: Card, b: Card) => CARD_STATUSES.indexOf(a.status) - CARD_STATUSES.indexOf(b.status) || a.position - b.position

/** A card in full. Chats on other machines say which. */
function detail(c: Card, cards: Card[], sessionId: string, archived: Set<string>, chats: ChatInfo[], machine: string): string {
  const lines = c.sessionIds.flatMap((id) => {
    const info = chats.find((i) => i.id === id)
    if (!info?.title && id !== sessionId) return []
    const where = info?.cwd && `in ${info.cwd}${info.machine && info.machine !== machine ? ` on ${info.machineName ?? info.machine}` : ''}`
    const notes = [where, archived.has(id) && 'archived', id === sessionId && 'this chat'].filter(Boolean)
    return [`- ${info?.title || 'New chat'} [${id}]${notes.length ? ` (${notes.join(', ')})` : ''}`]
  })
  const path = ancestors(cards, c.id)
  const inside = tree(cards, c.id, undefined, undefined)
  return [
    `#${c.id} ${c.title}`,
    `Status: ${c.status}`,
    ...(path.length ? [`Inside: ${path.map((p) => `#${p.id} ${p.title}`).join(' > ')}`] : []),
    '',
    c.description.trim() || '(no description)',
    '',
    lines.length ? `Chats:\n${lines.join('\n')}` : 'No chats.',
    ...(inside.length ? ['', `Cards inside it:\n${inside.join('\n')}`] : []),
  ].join('\n')
}

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] })
const error = (t: string) => ({ content: [{ type: 'text' as const, text: t }], isError: true })
