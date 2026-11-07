import type { SessionSummary } from '../shared/protocol.ts'
import { folderLabel } from './folders.ts'
import { cardOf, projectOfChat } from './stores/cards.ts'
import { sessions } from './stores/sessions.ts'

/**
 * Every chat that matches a search, archived ones and other projects' too, since a chat you can't find is usually
 * one that isn't in front of you: every word has to be in its title, folder, card or project. Archived ones come
 * after the rest. Undefined for an empty search.
 */
export function searchChats(query: string): SessionSummary[] | undefined {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return
  const matches = sessions().filter((s) => {
    const card = cardOf(s.id)
    const text = [s.title, s.cwd && folderLabel(s.cwd), card && `#${card.id} ${card.title}`, projectOfChat(s.id)?.title].join(' ').toLowerCase()
    return words.every((w) => text.includes(w))
  })
  return [...matches.filter((s) => !s.archived), ...matches.filter((s) => s.archived)]
}
