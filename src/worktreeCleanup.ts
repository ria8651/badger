import type { WorktreeStatus } from '../shared/protocol.ts'
import { api } from './api.ts'
import { folderLabel, worktreeOf } from './folders.ts'
import { plural } from './format.ts'
import { LOCAL } from './machines.ts'
import { confirmBy, showError, type Anchor } from './components/Popover.tsx'
import { cards, updateCard } from './stores/cards.ts'
import { sessions } from './stores/sessions.ts'
import { inWs, terminals, type Ws } from './terminals.ts'

/** The terminals running in a worktree, which go when it does. */
export const terminalsIn = (ws: Ws) => terminals().filter((t) => inWs(t, ws))

/** What removing a worktree takes with it, or leaves, for under the question. */
export function removalNotes(ws: Ws, branch: string, unmerged: number): string[] {
  const open = terminalsIn(ws).length
  return [
    unmerged ? `Its branch ${branch} has ${plural(unmerged, 'unmerged commit')}, so it will be kept.` : '',
    open ? `Its ${plural(open, 'terminal')} will be closed.` : '',
  ].filter(Boolean)
}

/**
 * The worktrees these chats leave with nothing in them once they're put away: no other chat that isn't archived
 * runs there, and none there is working. Worked out before they're archived, since finishing a card archives its
 * chats on the server.
 */
export function leftBehind(ids: string[]): Ws[] {
  const all = sessions().filter((s) => !s.sideOf && !s.gone && s.cwd && worktreeOf(s.cwd))
  // One archived already was asked about then, or was put away some other way.
  const going = all.filter((s) => ids.includes(s.id) && !s.archived)
  const found = new Map<string, Ws>()
  for (const s of going) found.set(`${s.machine || LOCAL} ${s.cwd}`, { machine: s.machine || LOCAL, root: s.cwd! })
  return [...found.values()].filter((ws) => {
    const inIt = all.filter((s) => (s.machine || LOCAL) === ws.machine && s.cwd === ws.root)
    return !inIt.some((s) => s.running || (!s.archived && !ids.includes(s.id)))
  })
}

/** Changes a card. Finishing one archives its chats, so then it offers to tidy up after them, by the card's control. */
export async function updateCardTidying(id: number, patch: Parameters<typeof updateCard>[1], anchor: () => Anchor): Promise<void> {
  const card = cards().find((c) => c.id === id)
  const left = card && patch.status === 'done' && card.status !== 'done' ? leftBehind(card.sessionIds) : []
  try {
    await updateCard(id, patch)
  } catch (e) {
    return showError("Couldn't change it", (e as Error).message, anchor())
  }
  await offerCleanup(anchor(), left)
}

/**
 * Offers to tidy up after the last chat in a worktree is put away: remove the worktree, with its terminals, if
 * nothing's uncommitted in it, else just close its terminals. Asks nothing when there's nothing to do.
 */
export async function offerCleanup(anchor: Anchor, left: Ws[]): Promise<void> {
  if (!left.length) return
  // Where it is now: an archived chat's row moves, and a finished card's is remade in its new column.
  if (anchor instanceof Element && anchor.isConnected) anchor = anchor.getBoundingClientRect()
  const found = await Promise.all(left.map((ws) => api.worktree(ws.root, ws.machine).then((s): [Ws, WorktreeStatus] => [ws, s], () => undefined)))
  const known = found.filter((f) => f !== undefined)
  const clean = known.filter(([, s]) => !s.changes)
  const dirty = known.filter(([ws, s]) => s.changes && terminalsIn(ws).length)
  if (!clean.length && !dirty.length) return

  const name = (ws: Ws) => folderLabel(ws.root)
  const theTerminals = (ws: Ws) => {
    const n = terminalsIn(ws).length
    return n === 1 ? 'the terminal' : `the ${n} terminals`
  }
  let message: string
  let notes: string[]
  let action: string
  if (clean.length + dirty.length === 1 && clean.length) {
    const [ws, s] = clean[0]
    message = `Remove worktree ${name(ws)}?`
    notes = removalNotes(ws, s.branch, s.unmerged)
    action = 'Remove'
  } else if (clean.length + dirty.length === 1) {
    const [ws] = dirty[0]
    message = `Close ${theTerminals(ws)} in ${name(ws)}?`
    notes = ['The worktree stays: it has uncommitted changes.']
    action = 'Close'
  } else {
    message = 'Tidy up after these chats?'
    notes = [
      ...clean.map(([ws, s]) => `Remove ${name(ws)}. ${removalNotes(ws, s.branch, s.unmerged).join(' ')}`.trim()),
      ...dirty.map(([ws]) => `Close ${theTerminals(ws)} in ${name(ws)}. It stays: it has uncommitted changes.`),
    ]
    action = clean.length && dirty.length ? 'Remove and close' : clean.length ? 'Remove' : 'Close'
  }
  if (!(await confirmBy(anchor, { message, notes, action }))) return

  const failed = (what: string) => (e: Error) => showError(what, e.message, anchor)
  await Promise.all([
    ...clean.map(([ws]) => api.removeWorktree(ws.root, ws.machine).catch(failed(`Couldn't remove ${name(ws)}`))),
    ...dirty.flatMap(([ws]) => terminalsIn(ws).map((t) => api.closeTerminal(t.id).catch(failed(`Couldn't close ${t.name ?? t.title}`)))),
  ])
}
