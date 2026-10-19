import { createEffect, createMemo, createRoot, createSignal, on } from 'solid-js'
import { route } from './router.tsx'
import { cardById, cardOf, cardsLoaded, projectOf, projectOfChat, projects } from './stores/cards.ts'

/**
 * The project this tab is working in, null for all of them, or 'none' for chats on no card, for filing them.
 * Per tab, so two tabs can be on two projects. It scopes the sidebar, the Board button and new chats.
 */
const FOCUS_KEY = 'badger.focus'
const stored = sessionStorage.getItem(FOCUS_KEY)
const [focusId, setFocusId] = createSignal<number | 'none' | null>(stored === 'none' ? 'none' : Number(stored) || null)
export { focusId, setFocusId }

/** Filing: showing the chats on no card. */
export const unfiled = () => focusId() === 'none'

/** The project in focus. Undefined while cards load, or if it was deleted or moved, in which case the tab shows everything. */
export const focus = createRoot(() => {
  const focus = createMemo(() => projects().find((c) => c.id === focusId()))

  createEffect(() => {
    const id = focusId()
    if (id === null) sessionStorage.removeItem(FOCUS_KEY)
    else sessionStorage.setItem(FOCUS_KEY, String(id))
  })

  // Focus follows where you go: a project's board focuses it, the projects board shows them all,
  // and opening something in another project moves there. Chats on no card leave it alone, and so does
  // filing the open chat, so only going somewhere moves it. Filing stays put until you open a project.
  createEffect(
    on([route, cardsLoaded], ([r]) => {
      const card = r.kind === 'card' ? cardById(r.id) : r.kind === 'chat' ? cardOf(r.id) : undefined
      if (card && (card.parentId ?? null) === null && r.kind === 'card') return setFocusId(card.id)
      if (focusId() === 'none') return
      if (r.kind === 'board') return setFocusId(null)
      const project = card && projectOf(card.id)
      if (project && focusId() !== null && project.id !== focusId()) setFocusId(project.id)
    }),
  )
  return focus
})

/** Whether a chat belongs in the sidebar as focused: in the project, or on no card while filing. */
export function inFocus(sessionId: string): boolean {
  if (unfiled()) return !cardOf(sessionId)
  const f = focus()
  return !f || projectOfChat(sessionId)?.id === f.id
}
