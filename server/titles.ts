import { getSessionMessages, query } from '@anthropic-ai/claude-agent-sdk'
import type { Card } from '../shared/protocol.ts'

const FIRST_PROMPT_LIMIT = 1500
const RECENT_LIMIT = 4000

const INSTRUCTIONS = `You name chats in a sidebar. Reply with only the title: 3 to 6 words, sentence case, no quotes or trailing punctuation.
Describe what the chat is about now, which may have moved on from how it started. Be specific enough to tell it apart from other chats.
If the chat is on a card, every chat on that card shares its topic, so name this chat's part of it rather than repeating the card title.`

/** A short title for a chat from its transcript, by a one-off model call that doesn't touch the chat itself. */
export async function suggestTitle(sessionId: string, current: string, card: Pick<Card, 'title' | 'description'> | undefined, cwd: string): Promise<string> {
  const turns = (await getSessionMessages(sessionId))
    .filter((m) => !m.parent_tool_use_id)
    .flatMap((m) => {
      const text = textOf(m.message)
      return text ? [`${m.type === 'user' ? 'User' : 'Claude'}: ${text}`] : []
    })
  if (!turns.length) throw new Error('Nothing in this chat to name yet')

  const first = turns[0].slice(0, FIRST_PROMPT_LIMIT)
  const recent: string[] = []
  let size = 0
  for (const t of turns.slice(1).reverse()) {
    const piece = t.length > 1000 ? t.slice(0, 1000) + '…' : t
    if (size + piece.length > RECENT_LIMIT) break
    recent.unshift(piece)
    size += piece.length
  }

  const prompt = [
    card && `Card: ${card.title}\n${card.description.trim().slice(0, 500)}`,
    `Current title (may be out of date): ${current}`,
    `How the chat started:\n${first}`,
    recent.length && `Most recently:\n${recent.join('\n\n')}`,
    'Reply with the new title only, 3 to 6 words.',
  ]
    .filter(Boolean)
    .join('\n\n---\n\n')

  let title = ''
  for await (const m of query({
    prompt,
    options: {
      cwd,
      model: 'haiku',
      systemPrompt: INSTRUCTIONS,
      tools: [],
      maxTurns: 1,
      thinking: { type: 'disabled' },
      settingSources: [],
      persistSession: false,
    },
  })) {
    if (m.type === 'result') {
      if (m.subtype !== 'success') throw new Error('Could not suggest a title')
      title = m.result
    }
  }
  title = title.trim().split('\n')[0].replace(/^["'`]+|["'`.]+$/g, '').trim()
  if (!title) throw new Error('Could not suggest a title')
  return title
}

/** The prose in a message: user prompts and Claude's replies, not tool calls or results. */
function textOf(message: unknown): string {
  const content = (message as { content?: unknown })?.content
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content
    .filter((b): b is { type: 'text'; text: string } => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim()
}
