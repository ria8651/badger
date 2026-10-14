import { tool, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { Children } from './children.ts'
import type { Store } from './db.ts'
import type { SessionManager } from './session.ts'
import { WORKTREE_PATH, worktreeStatus } from './workspace.ts'

export const REVIEW_TOOL = 'review_changes'

export interface ReviewDeps {
  store: Store
  manager: SessionManager
  children: Children
}

/**
 * A second opinion on a worktree's changes, as a tool for the chat that made
 * them. A child chat reviews them with fresh context while this one waits.
 * The prompt is deliberately bare: user and repo skills decide how a review
 * is done and what the report looks like.
 */
export function reviewTool(deps: ReviewDeps, sessionId: string, cwd: () => string, toolName: string): SdkMcpToolDefinition<any> {
  return tool(
    REVIEW_TOOL,
    [
      "Have a fresh chat review this worktree's changes: its commits not yet on the main checkout's branch, plus anything uncommitted. Use it when the user asks for a review.",
      "The reviewer works in this worktree, doesn't change anything, and its report is the result. Tell the user what it found, then act on it as they asked.",
    ].join(' '),
    {
      focus: z.string().optional().describe('Anything the user asked the reviewer to look at in particular'),
    },
    async ({ focus }, extra) => {
      const dir = cwd()
      if (!WORKTREE_PATH.test(dir)) return error(`This chat isn't in a Claude Code worktree (it's in ${dir}), so there's no branch to review.`)
      const parent = deps.manager.get(sessionId)
      const toolUseId = parent?.takeToolUse(toolName)
      if (!parent || !toolUseId) return error("Badger couldn't find this tool call, so it can't show the review. Try again.")

      const status = await worktreeStatus(dir)
      if (!status.unmerged && !status.changes) return error(`Nothing to review: ${status.branch} has no changes that aren't on ${status.base}.`)

      const card = deps.store.cards().find((c) => c.sessionIds.includes(sessionId))
      const prompt = [
        `Review the changes on \`${status.branch}\` that aren't on \`${status.base}\` yet, including uncommitted ones. Another chat made them and is waiting on your report, so don't change anything.`,
        ...(card ? ['', `The work is for card #${card.id}: ${card.title}.`] : []),
        ...(focus?.trim() ? ['', focus.trim()] : []),
      ].join('\n')

      const result = await deps.children.run(parent, {
        toolUseId,
        kind: 'review',
        cwd: dir,
        prompt,
        signal: (extra as { signal?: AbortSignal } | undefined)?.signal,
      })
      return result.ok ? text(result.text) : error(`The review didn't finish. ${result.text}`)
    },
  )
}

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] })
const error = (t: string) => ({ content: [{ type: 'text' as const, text: t }], isError: true })
