import { createHash } from 'node:crypto'
import { createSdkMcpServer, getSessionInfo, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { CARD_STATUSES, type Card } from '../shared/protocol.ts'
import { NO_CARD_CONTEXT, renderCardContext } from '../shared/cardContext.ts'
import type { Actor, Store } from './db.ts'

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
  const card = store.cards().find((c) => c.sessionIds.includes(sessionId))
  const last = store.contextHash(sessionId)
  if (!card) {
    if (last === undefined) return undefined
    store.setContextHash(sessionId, null)
    return NO_CARD_CONTEXT
  }
  const rendered = renderCardContext(card)
  const hash = hashOf(rendered)
  if (hash === last) return undefined
  store.setContextHash(sessionId, hash)
  return rendered
}

const hashOf = (text: string) => createHash('sha1').update(text).digest('hex')

/**
 * The project board as tools, for one chat. A new instance per Claude Code
 * process: it knows which chat it is so "this chat" means something.
 */
export function boardServer(store: Store, sessionId: string, onChange: () => void): McpSdkServerConfigWithInstance {
  const actor: Actor = { source: 'claude', sessionId }
  const thisCard = () => store.cards().find((c) => c.sessionIds.includes(sessionId))
  // Claude already knows this state (it wrote or just read it), so don't inject it next turn.
  const markSeen = (card: Card) => {
    if (card.sessionIds.includes(sessionId)) store.setContextHash(sessionId, hashOf(renderCardContext(card)))
  }
  const changed = <T>(value: T): T => {
    onChange()
    return value
  }

  return createSdkMcpServer({
    name: BOARD_SERVER,
    alwaysLoad: true,
    instructions: [
      "This chat runs inside Badger, which has a project board: cards are units of work, each with a status column and the chats working on it. Cards aren't tied to a repo; one card can hold chats in several repos.",
      "When this chat is on a card, the card's current state is added to the conversation whenever it changes. get_card with no id fetches it on demand.",
      'Use these tools when the user talks about cards, the board, tasks or what to work on. Keep a card you are working on up to date: move its status as work progresses and write what you learn into its description.',
      `Statuses, in board order: ${CARD_STATUSES.join(', ')}.`,
    ].join('\n'),
    tools: [
      tool(
        'list_cards',
        'List cards on the board, in board order. Marks the card this chat belongs to.',
        { status: status.optional().describe('Only cards in this column') },
        async (args) => {
          const mine = thisCard()?.id
          const cards = store.cards().filter((c) => !args.status || c.status === args.status)
          return text(cards.length ? cards.map((c) => summary(c, c.id === mine)).join('\n') : 'No cards.')
        },
        { annotations: { readOnlyHint: true } },
      ),
      tool(
        'get_card',
        "Get a card's full description and its chats. Omit id for the card this chat belongs to.",
        { id: z.number().int().optional() },
        async (args) => {
          const card = args.id === undefined ? thisCard() : store.card(args.id)
          if (!card) return error(args.id === undefined ? 'This chat is not on a card.' : `No card #${args.id}.`)
          markSeen(card)
          return text(await detail(card, sessionId, store.archivedIds()))
        },
        { annotations: { readOnlyHint: true } },
      ),
      tool(
        'create_card',
        'Create a card. It goes to the bottom of its column.',
        {
          title: z.string().min(1),
          description: z.string().optional().describe('Markdown'),
          status: status.optional().describe('Defaults to backlog'),
          link_this_chat: z.boolean().optional().describe('Also put this chat on the new card'),
        },
        async (args) => {
          const card = store.createCard(args, actor)
          if (args.link_this_chat) store.linkSession(card.id, sessionId, actor)
          const created = store.card(card.id)!
          markSeen(created)
          return changed(text(`Created ${summary(created, !!args.link_this_chat)}`))
        },
      ),
      tool(
        'update_card',
        "Change a card's title, description or status. Description replaces the whole text, so read it first with get_card.",
        {
          id: z.number().int(),
          title: z.string().min(1).optional(),
          description: z.string().optional().describe('Markdown; replaces the existing description'),
          status: status.optional(),
        },
        async ({ id, ...patch }) => {
          const card = store.updateCard(id, patch, actor)
          if (!card) return error(`No card #${id}.`)
          markSeen(card)
          return changed(text(`Updated ${summary(card, card.id === thisCard()?.id)}`))
        },
        { annotations: { idempotentHint: true } },
      ),
      tool(
        'link_chat',
        'Put this chat on a card, moving it off any card it was on.',
        { id: z.number().int() },
        async ({ id }) => {
          if (!store.card(id)) return error(`No card #${id}.`)
          store.linkSession(id, sessionId, actor)
          return changed(text(`This chat is now on card #${id}.`))
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
          store.setArchived(id, archived, actor)
          const which = id === sessionId ? 'This chat' : `Chat ${id}`
          return text(`${which} is ${archived ? 'archived' : 'not archived'}.`)
        },
        { annotations: { idempotentHint: true } },
      ),
      tool(
        'delete_card',
        'Delete a card. Its chats are kept. Only do this when the user asks.',
        { id: z.number().int() },
        async ({ id }) => (store.deleteCard(id, actor) ? changed(text(`Deleted card #${id}.`)) : error(`No card #${id}.`)),
        { annotations: { destructiveHint: true } },
      ),
    ],
  })
}

function summary(c: Card, mine: boolean): string {
  const chats = c.sessionIds.length ? `, ${c.sessionIds.length} chat${c.sessionIds.length === 1 ? '' : 's'}` : ''
  return `#${c.id} [${c.status}] ${c.title}${chats}${mine ? ' (this chat)' : ''}`
}

async function detail(c: Card, sessionId: string, archived: Set<string>): Promise<string> {
  const chats = await Promise.all(
    c.sessionIds.map(async (id) => {
      const info = await getSessionInfo(id).catch(() => undefined)
      if (!info && id !== sessionId) return null
      const title = info?.customTitle || info?.summary || info?.firstPrompt || 'New chat'
      const notes = [info?.cwd && `in ${info.cwd}`, archived.has(id) && 'archived', id === sessionId && 'this chat'].filter(Boolean)
      return `- ${title} [${id}]${notes.length ? ` (${notes.join(', ')})` : ''}`
    }),
  )
  const lines = chats.filter(Boolean)
  return [
    `#${c.id} ${c.title}`,
    `Status: ${c.status}`,
    '',
    c.description.trim() || '(no description)',
    '',
    lines.length ? `Chats:\n${lines.join('\n')}` : 'No chats.',
  ].join('\n')
}

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] })
const error = (t: string) => ({ content: [{ type: 'text' as const, text: t }], isError: true })
