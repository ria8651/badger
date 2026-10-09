import type { WorktreeStatus } from '../shared/protocol.ts'

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

export function chatActions(ctx: { worktree?: WorktreeStatus }): ChatAction[] {
  const actions: ChatAction[] = []
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
  return actions
}
