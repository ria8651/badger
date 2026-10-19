import { LOCAL, machineOf, machines } from './machines.ts'
import { config } from './stores/config.ts'

/** Where folderless chats run on the hub's own machine, from the server's config. */
const scratch = () => config()?.scratchCwd

/** Where a machine's folderless chats run: the hub's from its config, another's once its runner has said. */
export const scratchDir = (machine: string = LOCAL) => machineOf(machine)?.scratchDir ?? (machine === LOCAL ? scratch() : undefined)

/** Any machine's folder for folderless chats. */
export const isScratch = (cwd?: string) => !!cwd && (cwd === scratch() || machines().some((m) => m.scratchDir === cwd))

export const basename = (path: string) => path.split('/').filter(Boolean).pop() ?? path

/** The repo and name of a worktree Claude Code made (`<repo>/.claude/worktrees/<name>`). */
export function worktreeOf(cwd?: string): { repo: string; name: string } | undefined {
  const m = cwd?.match(/^(.*)\/\.claude\/worktrees\/([^/]+)\/?$/)
  return m ? { repo: m[1], name: m[2] } : undefined
}

/** How a chat's directory is shown: its last segment, "repo · name" for a worktree, or "No folder" for scratch. */
export function folderLabel(cwd: string): string {
  if (isScratch(cwd)) return 'No folder'
  const wt = worktreeOf(cwd)
  return wt ? `${basename(wt.repo)} · ${wt.name}` : basename(cwd)
}

/** A worktree name for a card's work: its number and the start of its title. */
export function cardWorktreeName(card: { id: number; title: string }): string {
  // Whole words only, up to about 30 characters.
  let slug = ''
  for (const word of card.title.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
    if (slug && slug.length + word.length + 1 > 30) break
    slug = slug ? `${slug}-${word}` : word.slice(0, 30)
  }
  return slug ? `${card.id}-${slug}` : `card-${card.id}`
}

/** Where a new chat should start: the repo of the most recent of these chats that ran in one, on its machine, and whether that was a worktree. */
export function lastWorkedIn(
  sessions: { cwd?: string; machine?: string; gone?: boolean; lastModified: number }[],
): { cwd: string; machine: string; worktree: boolean } | undefined {
  const latest = sessions
    .filter((s) => s.cwd && !s.gone && !isScratch(s.cwd))
    .reduce<(typeof sessions)[number] | undefined>((a, s) => (!a || s.lastModified > a.lastModified ? s : a), undefined)
  if (!latest?.cwd) return undefined
  const wt = worktreeOf(latest.cwd)
  return { cwd: wt?.repo ?? latest.cwd, machine: latest.machine || LOCAL, worktree: !!wt }
}
