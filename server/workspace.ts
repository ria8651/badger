import { execFileSync } from 'node:child_process'

/** The git root of a directory (each worktree has its own), or the directory itself outside a repo. */
export function workspaceRoot(cwd: string): string {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || cwd
  } catch {
    return cwd
  }
}
