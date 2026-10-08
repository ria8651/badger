import { execFile, execFileSync } from 'node:child_process'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { WorktreeStatus } from '../shared/protocol.ts'

/** The git root of a directory (each worktree has its own), or the directory itself outside a repo. */
export function workspaceRoot(cwd: string): string {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || cwd
  } catch {
    return cwd
  }
}

const run = promisify(execFile)
const git = async (cwd: string, ...args: string[]) => (await run('git', args, { cwd })).stdout.trim()

/** Where Claude Code puts the worktrees it makes (--worktree, EnterWorktree). */
export const WORKTREE_PATH = /^(.*)\/\.claude\/worktrees\/([^/]+)\/?$/

/**
 * Claude Code makes worktrees inside the repo, which leaves `.claude/` untracked
 * in the main checkout. Hide them in `.git/info/exclude`, which is local and never
 * committed, rather than touching the repo's .gitignore.
 */
export async function excludeWorktrees(cwd: string): Promise<void> {
  const common = resolve(cwd, await git(cwd, 'rev-parse', '--git-common-dir'))
  const file = join(common, 'info', 'exclude')
  const line = '/.claude/worktrees/'
  const current = await readFile(file, 'utf8').catch(() => '')
  if (current.split('\n').includes(line)) return
  await mkdir(dirname(file), { recursive: true })
  await appendFile(file, `${current && !current.endsWith('\n') ? '\n' : ''}${line}\n`)
}

/** The main checkout a worktree belongs to. */
async function mainCheckout(path: string): Promise<string> {
  return dirname(resolve(path, await git(path, 'rev-parse', '--git-common-dir')))
}

export async function worktreeStatus(path: string): Promise<WorktreeStatus> {
  if (!WORKTREE_PATH.test(path)) throw new Error('Not a Claude Code worktree')
  const main = await mainCheckout(path)
  const [branch, status, base] = await Promise.all([
    git(path, 'branch', '--show-current'),
    git(path, 'status', '--porcelain'),
    git(main, 'branch', '--show-current'),
  ])
  const unmerged = Number(await git(path, 'rev-list', '--count', `${await git(main, 'rev-parse', 'HEAD')}..HEAD`))
  return { path, branch, changes: status ? status.split('\n').length : 0, unmerged, base }
}

/**
 * Remove a worktree the way `git worktree remove` would: refused if it has
 * uncommitted changes. Its branch is deleted only if it's merged, so no commit
 * is ever lost.
 */
export async function removeWorktree(path: string): Promise<void> {
  if (!WORKTREE_PATH.test(path)) throw new Error('Not a Claude Code worktree')
  const main = await mainCheckout(path)
  const branch = await git(path, 'branch', '--show-current')
  // Claude Code locks worktrees it's using and doesn't always unlock them when the process ends.
  await git(main, 'worktree', 'unlock', path).catch(() => {})
  await git(main, 'worktree', 'remove', path).catch((err: { stderr?: string }) => {
    if (err.stderr?.includes('modified or untracked')) throw new Error('It has uncommitted changes. Commit or discard them first.')
    throw new Error(err.stderr?.trim().replace(/^fatal: /, '') || 'git worktree remove failed')
  })
  if (branch) await git(main, 'branch', '-d', branch).catch(() => {})
}
