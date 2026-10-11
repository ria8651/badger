import { existsSync } from 'node:fs'
import { tool, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { Card } from '../shared/protocol.ts'
import type { Children } from './children.ts'
import type { Actor } from './db.ts'
import type { Remote } from './peer.ts'
import type { Board } from './runnerProtocol.ts'
import type { SessionManager } from './session.ts'
import type { Terminals } from './terminals.ts'
import { WORKTREE_PATH, mainCheckout, mergeBlocker, removeWorktree, worktreeStatus } from './workspace.ts'

export const MERGE_TOOL = 'merge_worktree'

/** The worktree, its chats and its terminals are all on the machine this runs on; the board is the hub's. */
export interface MergeDeps {
  board: Remote<Board>
  /** This machine's id. */
  machine: () => string
  manager: SessionManager
  terminals: Terminals
  children: Children
}

/** One merge into a checkout at a time; later ones wait their turn. */
const locks = new Map<string, Promise<unknown>>()

function serialised<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const run = (locks.get(key) ?? Promise.resolve()).then(fn, fn)
  const settled = run.catch(() => {})
  locks.set(key, settled)
  void settled.then(() => locks.get(key) === settled && locks.delete(key))
  return run
}

/**
 * Merging a worktree, as a tool for the chat working in it. A worktree can't
 * merge itself, so a child chat in the main checkout does the merge while this
 * one waits. Once it lands, Badger cleans up after this chat's turn ends: it
 * can't remove the worktree while this chat is still running in it.
 */
export function mergeTool(deps: MergeDeps, sessionId: string, cwd: () => string, toolName: string): SdkMcpToolDefinition<any> {
  return tool(
    MERGE_TOOL,
    [
      "Merge this chat's worktree branch into the branch the main checkout is on. Use it when the user asks to merge.",
      'Commit everything first. Badger starts a chat in the main checkout that merges the branch, resolves any conflicts and runs checks, and waits for it; that chat\'s report is the result.',
      'Once the merge lands, Badger removes this worktree and its branch and archives this chat after this turn ends, so do nothing more in the worktree: just tell the user what happened.',
    ].join(' '),
    {
      notes: z
        .string()
        .optional()
        .describe('For the chat doing the merge: what the change does and anything likely to conflict or need care'),
    },
    async ({ notes }, extra) => {
      const dir = cwd()
      if (!WORKTREE_PATH.test(dir)) return error(`This chat isn't in a Claude Code worktree (it's in ${dir}), so there's nothing to merge.`)
      const parent = deps.manager.get(sessionId)
      const toolUseId = parent?.takeToolUse(toolName)
      if (!parent || !toolUseId) return error("Badger couldn't find this tool call, so it can't show the merge. Try again.")

      const status = await worktreeStatus(dir)
      if (status.changes) {
        return error(`${plural(status.changes, 'file has', 'files have')} uncommitted changes. Commit or discard them, then merge again.`)
      }
      if (!status.unmerged) return error(`Nothing to merge: every commit on ${status.branch} is already on ${status.base}.`)
      const main = await mainCheckout(dir)

      return serialised(main, async () => {
        const blocker = await mergeBlocker(main)
        if (blocker) return error(`${blocker} Sort that out in the main checkout, then merge again.`)
        const busy = deps.manager.in(main).filter((s) => s.running)
        if (busy.length) return error(`Another chat is working in the main checkout (${main}). Wait for it to finish, then merge again.`)

        const card = (await deps.board.cards()).find((c) => c.sessionIds.includes(sessionId))
        const before = await worktreeStatus(dir)
        const result = await deps.children.run(parent, {
          toolUseId,
          kind: 'merge',
          cwd: main,
          prompt: mergePrompt({ dir, branch: before.branch, base: before.base, unmerged: before.unmerged, notes, card }),
          signal: (extra as { signal?: AbortSignal } | undefined)?.signal,
        })

        const after = await worktreeStatus(dir).catch(() => undefined)
        if (!after || after.unmerged) {
          const why = result.ok ? `The merge chat finished but ${before.branch} still isn't on ${before.base}.` : "The merge didn't finish."
          return error(`${why} Its report:\n\n${result.text}`)
        }

        const finished = await cardFinished(deps, card, dir)
        parent.afterTurn(() => void cleanUp(deps, { sessionId, dir, card: finished ? card : undefined }))
        const then = finished
          ? `moves card #${card!.id} to done, which archives its chats`
          : 'archives this chat' + (card ? ` (card #${card.id} stays where it is: it has other chats still going)` : '')
        return text(
          `Merged ${before.branch} into ${before.base}. When this turn ends, Badger removes this worktree and its branch, closes its terminals and ${then}.\n\nThe merge chat's report:\n\n${result.text}`,
        )
      })
    },
  )
}

function mergePrompt(p: { dir: string; branch: string; base: string; unmerged: number; notes?: string; card?: Card }): string {
  return [
    `You're merging another Badger chat's work. That chat worked in the git worktree ${p.dir}, on branch \`${p.branch}\`, which has ${plural(p.unmerged, 'commit', 'commits')} not on \`${p.base}\`. Worktrees can't merge themselves, so it's waiting on you.`,
    '',
    `Merge it into \`${p.base}\` here in the main checkout:`,
    `- Run \`git merge --no-edit ${p.branch}\`. A merge commit is fine; don't rebase or squash.`,
    "- Resolve any conflicts so both sides' changes survive, reading the commits on each side when you need their intent, then commit the merge. If you can't resolve a conflict confidently, run `git merge --abort` and explain what's in the way.",
    '- Run the project\'s quick checks (typecheck, lint, fast tests) if it has them, and fix anything the merge broke.',
    "- Don't push, don't remove the worktree or the branch, and don't change cards or archive chats: Badger does that once the merge lands.",
    '',
    'Finish with a short report for the other chat: whether it merged, which conflicts there were and how you resolved them, and which checks you ran.',
    ...(p.card ? ['', `The work is for card #${p.card.id}: ${p.card.title}.`] : []),
    ...(p.notes?.trim() ? ['', 'Notes from the chat that did the work:', '', p.notes.trim()] : []),
  ].join('\n')
}

/**
 * Whether merging this worktree finishes the card: every other chat on it is
 * archived or ran somewhere that's gone. Cards often hold more than one piece
 * of work, so anything else still around keeps the card open, including
 * chats on other machines, whose folders can't be checked from here.
 */
async function cardFinished(deps: MergeDeps, card: Card | undefined, dir: string): Promise<boolean> {
  if (!card) return false
  const archived = new Set(await deps.board.archivedIds())
  const others = await deps.board.chatInfo(card.sessionIds.filter((id) => !archived.has(id)))
  return others.every((c) => {
    const cwd = deps.manager.get(c.id)?.cwd ?? c.cwd
    if (c.machine && c.machine !== deps.machine()) return !cwd
    return !cwd || cwd === dir || !existsSync(cwd)
  })
}

/** After the merging chat's turn: the worktree goes, and the chat (or its whole card) is put away. */
async function cleanUp(deps: MergeDeps, p: { sessionId: string; dir: string; card?: Card }): Promise<void> {
  const actor: Actor = { source: 'claude', sessionId: p.sessionId }
  try {
    if (deps.manager.in(p.dir).some((s) => s.running)) throw new Error('a chat is still working in it')
    for (const s of deps.manager.in(p.dir)) s.close()
    for (const t of deps.terminals.terminals.filter((t) => t.root === p.dir)) await deps.terminals.remove(t.id)
    await removeWorktree(p.dir)
  } catch (err) {
    console.error(`Merged, but couldn't remove worktree ${p.dir}: ${err instanceof Error ? err.message : err}`)
  }
  try {
    if (p.card) await deps.board.updateCard(p.card.id, { status: 'done' }, actor)
    else await deps.board.setArchived(p.sessionId, true, actor)
  } catch (err) {
    console.error(`Merged, but couldn't put the chat away: ${err instanceof Error ? err.message : err}`)
  }
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] })
const error = (t: string) => ({ content: [{ type: 'text' as const, text: t }], isError: true })
