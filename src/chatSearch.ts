import { chatMatches, searchWords } from '../shared/chatSearch.ts'
import type { SessionSummary } from '../shared/protocol.ts'
import { folderLabel } from './folders.ts'
import { cardOf, projectOfChat } from './stores/cards.ts'
import { sessions } from './stores/sessions.ts'

/**
 * Every chat that isn't archived that matches a search, other projects' too, since a chat you can't find is usually one
 * that isn't in front of you: every word has to be in its title, folder, card or project. Archived ones are the
 * server's to find, after these (see createArchivedList). Undefined for an empty search.
 */
export function searchChats(query: string): SessionSummary[] | undefined {
  const words = searchWords(query)
  if (!words.length) return
  return sessions().filter(
    (s) => !s.archived && chatMatches(words, { title: s.title, folder: s.cwd && folderLabel(s.cwd), card: cardOf(s.id), project: projectOfChat(s.id) }),
  )
}
