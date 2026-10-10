import { CARD_STATUSES, type Card, type CardStatus } from './protocol.ts'

/** Longer descriptions are cut in injected context; get_card has the rest. */
const CONTEXT_DESCRIPTION_LIMIT = 4000

export const NO_CARD_CONTEXT = 'This chat is no longer on a card.'

/** A chat's card as Claude is told about it, with the cards it sits inside. Changing this text re-injects it into every chat on a card once. */
export function renderCardContext(c: Card, path: Pick<Card, 'id' | 'title'>[] = []): string {
  let description = c.description.trim() || '(no description)'
  if (description.length > CONTEXT_DESCRIPTION_LIMIT)
    description = description.slice(0, CONTEXT_DESCRIPTION_LIMIT) + '\n[truncated; call get_card for the rest]'
  return [
    `This chat is on Badger card #${c.id}: ${c.title}`,
    `Status: ${c.status}`,
    ...(path.length ? [`Inside: ${path.map((p) => `#${p.id} ${p.title}`).join(' > ')}`] : []),
    'This is the current state of the card. It is new to you or changed since you last saw it, possibly edited by the user on the board.',
    '',
    description,
  ].join('\n')
}

export type CardContext = { card: Pick<Card, 'id' | 'title' | 'status' | 'description'> } | { card: null }

/** Reads back context written by renderCardContext, or undefined for any other text. */
export function parseCardContext(text: string): CardContext | undefined {
  if (text.trim() === NO_CARD_CONTEXT) return { card: null }
  const m = text.match(/^This chat is on Badger card #(\d+): (.*)\nStatus: (\w+)\n(?:Inside: .*\n)?.*\n\n([\s\S]*)$/)
  if (!m || !CARD_STATUSES.includes(m[3] as CardStatus)) return undefined
  const description = m[4].trim() === '(no description)' ? '' : m[4].trim()
  return { card: { id: Number(m[1]), title: m[2], status: m[3] as CardStatus, description } }
}
