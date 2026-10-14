import type { ChangesStatus, WorktreeStatus } from '../shared/protocol.ts'

/**
 * Something a chat can be asked to do from the composer. Each is a prompt;
 * what makes it more than a prompt is the Badger tool it leads Claude to,
 * which does the parts Claude can't, like running a chat elsewhere and
 * cleaning up after the turn.
 */
export interface ChatAction {
  label: string
  description: string
  prompt: string
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

export function chatActions(ctx: { worktree?: WorktreeStatus; changes?: ChangesStatus }): ChatAction[] {
  const actions: ChatAction[] = []
  const ch = ctx.changes
  if (ch) {
    const pending = [ch.ahead && `${plural(ch.ahead, 'commit')} not on ${ch.base}`, ch.changes && plural(ch.changes, 'uncommitted change')].filter(Boolean)
    actions.push({
      label: 'Review changes',
      description: pending.length
        ? `${pending.join(', ')}. A fresh chat reviews them and reports back here.`
        : `Nothing to review: no uncommitted changes${ch.base ? `, and everything is already on ${ch.base}` : ''}.`,
      prompt: 'Have the changes here reviewed.',
    })
  }
  const wt = ctx.worktree
  if (wt) {
    // Uncommitted work counts: Claude commits it before merging.
    const pending = [wt.unmerged && plural(wt.unmerged, 'commit'), wt.changes && plural(wt.changes, 'uncommitted change')].filter(Boolean)
    actions.push({
      label: `Merge into ${wt.base}`,
      description: pending.length
        ? `${pending.join(', ')}. A chat in the main checkout merges it, then the worktree goes.`
        : `Nothing to merge: everything here is already on ${wt.base}.`,
      prompt: `Merge this worktree into ${wt.base}.`,
    })
  }
  actions.push({
    label: 'Preview',
    description: 'Start the dev server, or reuse a running one, and show it beside the chat.',
    prompt: 'Start a preview of this app.',
  })
  return actions
}
