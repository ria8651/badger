/** A search's words, lowercased. */
export const searchWords = (query: string): string[] => query.toLowerCase().split(/\s+/).filter(Boolean)

/** Whether a chat matches a search: every word has to be in its title, folder, card or project. */
export function chatMatches(
  words: string[],
  chat: { title: string; folder?: string; card?: { id: number; title: string }; project?: { title: string } },
): boolean {
  const text = [chat.title, chat.folder, chat.card && `#${chat.card.id} ${chat.card.title}`, chat.project?.title].join(' ').toLowerCase()
  return words.every((w) => text.includes(w))
}
