import type { GitStatus } from '../shared/protocol.ts'
import { worktreeOf } from './folders.ts'
import { plural } from './format.ts'

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

/** cwd decides whether it can be merged: Badger merges the worktrees Claude Code makes, not others. */
export function chatActions(git?: GitStatus, cwd?: string): ChatAction[] {
  const actions: ChatAction[] = []
  if (git) {
    // A worktree's work is measured against the main checkout, any other branch's against its upstream.
    const base = git.base?.branch ?? git.upstream
    const ahead = git.base ? git.base.ahead : git.ahead
    const pending = [ahead && `${plural(ahead, 'commit')} not on ${base}`, git.changes && plural(git.changes, 'uncommitted change')].filter(Boolean)
    actions.push({
      label: 'Review changes',
      description: pending.length
        ? `${pending.join(', ')}. A fresh chat reviews them and reports back here.`
        : `Nothing to review: no uncommitted changes${base ? `, and everything is already on ${base}` : ''}.`,
      prompt: 'Have the changes here reviewed.',
    })
  }
  if (git?.base && worktreeOf(cwd)) {
    const wt = git.base
    // Uncommitted work counts: Claude commits it before merging.
    const pending = [wt.ahead && plural(wt.ahead, 'commit'), git.changes && plural(git.changes, 'uncommitted change')].filter(Boolean)
    actions.push({
      label: `Merge into ${wt.branch}`,
      description: pending.length
        ? `${pending.join(', ')}. A chat in the main checkout merges it, then the worktree goes.`
        : `Nothing to merge: everything here is already on ${wt.branch}.`,
      prompt: `Merge this worktree into ${wt.branch}.`,
    })
  }
  actions.push({
    label: 'Preview',
    description: 'Start the dev server, or reuse a running one, and show it beside the chat.',
    prompt: 'Start a preview of this app.',
  })
  return actions
}
