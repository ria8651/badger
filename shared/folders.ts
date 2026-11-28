export const basename = (path: string) => path.split('/').filter(Boolean).pop() ?? path

/** The repo and name of a worktree Claude Code made (`<repo>/.claude/worktrees/<name>`). */
export function worktreeOf(cwd?: string): { repo: string; name: string } | undefined {
  const m = cwd?.match(/^(.*)\/\.claude\/worktrees\/([^/]+)\/?$/)
  return m ? { repo: m[1], name: m[2] } : undefined
}

/** How a chat's directory is shown: its last segment, "repo · name" for a worktree, or "No folder" for a machine's scratch folder. */
export function folderLabelOf(cwd: string, scratch: boolean): string {
  if (scratch) return 'No folder'
  const wt = worktreeOf(cwd)
  return wt ? `${basename(wt.repo)} · ${wt.name}` : basename(cwd)
}

/** Whether `path` is `dir` or inside it. */
export const within = (path: string, dir: string) => path === dir || path.startsWith(`${dir}/`)
