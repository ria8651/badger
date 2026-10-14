import { tool, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { Children } from './children.ts'
import type { Store } from './db.ts'
import type { SessionManager } from './session.ts'
import { changesStatus } from './workspace.ts'

export const REVIEW_TOOL = 'review_changes'

export interface ReviewDeps {
  store: Store
  manager: SessionManager
  children: Children
}

/**
 * A second opinion on the work in a chat's checkout, as a tool for that chat.
 * A child chat reviews it with fresh context while this one waits.
 * The prompt is deliberately bare: user and repo skills decide how a review
 * is done and what the report looks like.
 */
export function reviewTool(deps: ReviewDeps, sessionId: string, cwd: () => string, toolName: string): SdkMcpToolDefinition<any> {
  return tool(
    REVIEW_TOOL,
    [
      "Have a fresh chat review the work in this chat's git checkout: uncommitted changes, plus commits not yet on the base (the main checkout's branch in a worktree, otherwise the upstream). Use it when the user asks for a review.",
      "The reviewer works in this checkout, doesn't change anything, and its report is the result. Tell the user what it found, then act on it as they asked.",
    ].join(' '),
    {
      focus: z.string().optional().describe('Anything the user asked the reviewer to look at in particular'),
    },
    async ({ focus }, extra) => {
      const dir = cwd()
      const parent = deps.manager.get(sessionId)
      const toolUseId = parent?.takeToolUse(toolName)
      if (!parent || !toolUseId) return error("Badger couldn't find this tool call, so it can't show the review. Try again.")

      const status = await changesStatus(dir)
      if (!status) return error(`${dir} isn't in a git repo, so there are no changes to review.`)
      if (!status.ahead && !status.changes) {
        return error(`Nothing to review: no uncommitted changes${status.base ? `, and every commit on ${status.branch} is already on ${status.base}` : ''}.`)
      }

      const card = deps.store.cards().find((c) => c.sessionIds.includes(sessionId))
      const what = [status.ahead && `the commits on \`${status.branch}\` that aren't on \`${status.base}\` yet`, status.changes && 'the uncommitted changes']
      const prompt = [
        `Review ${what.filter(Boolean).join(' and ')}. Another chat is waiting on your report, so don't change anything.`,
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
