import { createSignal } from 'solid-js'
import { LOCAL, machineName, machines, severalMachines } from './machines.ts'

/** Where folderless chats run on the hub's own machine, from the server's config. */
const [scratch, setScratch] = createSignal<string>()
export { setScratch }

/** Any machine's folder for folderless chats. */
export const isScratch = (cwd?: string) => !!cwd && (cwd === scratch() || machines().some((m) => m.scratchDir === cwd))

export const basename = (path: string) => path.split('/').filter(Boolean).pop() ?? path

/**
 * A folder on a machine, as one string (`<machine>:<path>`), so pickers and
 * drafts can hold it like a path. Machine ids never contain a colon.
 */
export type Place = string

export const place = (machine: string | undefined, cwd: string): Place => `${machine || LOCAL}:${cwd}`

export function unplace(p: Place): { machine: string; cwd: string } {
  const i = p.indexOf(':')
  return { machine: p.slice(0, i), cwd: p.slice(i + 1) }
}

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

/** Which machine something's on, the hub's own included, once there's more than one to tell apart. */
export const onMachine = (machine?: string) => (severalMachines() ? machineName(machine) : '')

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

/** For directory pickers: scratch gets a description instead of its path; the machine shows when there's more than one. */
export const folderItem = (p: Place) => {
  const { machine, cwd } = unplace(p)
  return {
    label: folderLabel(cwd),
    description: isScratch(cwd) ? 'Quick questions, not tied to a repo' : cwd,
    mono: !isScratch(cwd),
    machine: onMachine(machine),
  }
}

/** Where a new chat should start: the repo of the most recent of these chats that ran in one, on its machine, and whether that was a worktree. */
export function lastWorkedIn(
  sessions: { cwd?: string; machine?: string; gone?: boolean; lastModified: number }[],
): { cwd: string; machine?: string; worktree: boolean } | undefined {
  const latest = sessions
    .filter((s) => s.cwd && !s.gone && !isScratch(s.cwd))
    .reduce<(typeof sessions)[number] | undefined>((a, s) => (!a || s.lastModified > a.lastModified ? s : a), undefined)
  if (!latest?.cwd) return undefined
  const wt = worktreeOf(latest.cwd)
  return { cwd: wt?.repo ?? latest.cwd, machine: latest.machine, worktree: !!wt }
}
