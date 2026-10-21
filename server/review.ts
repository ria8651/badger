import { z } from 'zod'
import type { Card } from '../shared/protocol.ts'
import { childTool, refuse, reply, type Children } from './children.ts'
import type { SessionManager } from './session.ts'
import { changesStatus } from './workspace.ts'

export const REVIEW_TOOL = 'review_changes'

export interface ReviewDeps {
  /** The card a chat on this machine is on, from the hub. */
  cardOf: (sessionId: string) => Promise<Card | undefined>
  manager: SessionManager
  children: Children
}

/**
 * A second opinion on the work in a chat's checkout, as a tool for that chat.
 * A child chat reviews it with fresh context while this one waits.
 * The prompt is deliberately bare: user and repo skills decide how a review
 * is done and what the report looks like.
 */
export function reviewTool(deps: ReviewDeps, sessionId: string, cwd: () => string, toolName: string) {
  return childTool(
    {
      name: REVIEW_TOOL,
      kind: 'review',
      description: [
        "Have a fresh chat review the work in this chat's git checkout: uncommitted changes, plus commits not yet on the base (the main checkout's branch in a worktree, otherwise the upstream). Use it when the user asks for a review.",
        "The reviewer works in this checkout, doesn't change anything, and its report is the result. Tell the user what it found, then act on it as they asked.",
      ].join(' '),
      input: {
        focus: z.string().optional().describe('Anything the user asked the reviewer to look at in particular'),
      },
    },
    deps,
    { sessionId, cwd, toolName },
    async ({ focus }, { dir, child }) => {
      const status = await changesStatus(dir)
      if (!status) return refuse(`${dir} isn't in a git repo, so there are no changes to review.`)
      if (!status.ahead && !status.changes) {
        return refuse(`Nothing to review: no uncommitted changes${status.base ? `, and every commit on ${status.branch} is already on ${status.base}` : ''}.`)
      }

      const card = await deps.cardOf(sessionId)
      const what = [status.ahead && `the commits on \`${status.branch}\` that aren't on \`${status.base}\` yet`, status.changes && 'the uncommitted changes']
      const prompt = [
        `Review ${what.filter(Boolean).join(' and ')}. Another chat is waiting on your report, so don't change anything.`,
        ...(card ? ['', `The work is for card #${card.id}: ${card.title}.`] : []),
        ...(focus?.trim() ? ['', focus.trim()] : []),
        // SPIKE: for the review panel, which shows these beside the diff.
        '',
        'End your report with a fenced code block tagged `findings`: a JSON array with one {"file", "line", "severity", "note"} for each issue on a specific line. file is relative to the checkout root, line is on the new side, severity is high, medium or low. An empty array if there are none.',
      ].join('\n')

      const result = await child(dir, prompt)
      return result.ok ? reply(result.text) : refuse(`The review didn't finish. ${result.text}`)
    },
  )
}
