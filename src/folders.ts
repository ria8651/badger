import { createSignal } from 'solid-js'

/** Where folderless chats run, from the server's config. */
const [scratch, setScratch] = createSignal<string>()
export { setScratch }

export const isScratch = (cwd?: string) => !!cwd && cwd === scratch()

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

/** For directory pickers: scratch gets a description instead of its path. */
export const folderItem = (cwd: string) => ({
  label: folderLabel(cwd),
  description: isScratch(cwd) ? 'Quick questions, not tied to a repo' : cwd,
  mono: !isScratch(cwd),
})
