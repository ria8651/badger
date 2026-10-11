import type { JSX } from 'solid-js'
import type { Card, SessionSummary } from '../../shared/protocol.ts'
import { api } from '../api.ts'
import { SearchMenu, type SearchItem } from './ui.tsx'

/**
 * Puts a chat on a project or one of its cards, picked by searching. Typing a name nothing matches makes it a new
 * project. Projects and cards that are done are left out, unless the chat is on one.
 */
export function FileChat(props: {
  session: SessionSummary
  cards: Card[]
  trigger: (open: () => boolean) => JSX.Element
  triggerClass: (open: boolean) => string
  title?: string
  onOpenChange?: (open: boolean) => void
}) {
  const items = (q: string): SearchItem[] => {
    const id = props.session.id
    const current = props.cards.find((c) => c.sessionIds.includes(id))
    const needle = q.toLowerCase()
    const matches = (c: Card) => !q || c.title.toLowerCase().includes(needle) || `#${c.id}` === q || String(c.id) === q
    const shown = (c: Card) => c.status !== 'done' || c.id === current?.id
    const item = (c: Card, indent: boolean): SearchItem => ({
      label: c.title,
      hint: `#${c.id}`,
      indent,
      selected: c.id === current?.id,
      pick: () => c.id !== current?.id && api.linkSession(c.id, id),
    })
    const list: SearchItem[] = []
    if (current && !q) list.push({ label: 'No project', description: `Take it off ${current.title}`, pick: () => api.unlinkSession(current.id, id) })
    for (const p of props.cards.filter((c) => c.parentId === null && shown(c))) {
      // A project that matches brings all its cards, for context; otherwise only the cards that match.
      const inside = props.cards.filter((c) => c.parentId === p.id && shown(c) && (matches(p) || matches(c)))
      if (!matches(p) && !inside.length) continue
      list.push(item(p, false), ...inside.map((c) => item(c, true)))
    }
    if (q && !props.cards.some((c) => c.parentId === null && c.title.trim().toLowerCase() === needle))
      list.push({ label: `New project “${q}”`, pick: () => api.createCard({ title: q }).then((p) => api.linkSession(p.id, id)) })
    return list
  }
  return (
    <SearchMenu
      items={items}
      placeholder="Find a project or card, or name a new project"
      empty="No projects yet. Type a name to make one."
      title={props.title}
      trigger={props.trigger}
      triggerClass={props.triggerClass}
      onOpenChange={props.onOpenChange}
    />
  )
}
