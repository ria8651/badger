import { execFileSync } from 'node:child_process'
import { accessSync, constants, existsSync, mkdirSync, writeFileSync, statSync } from 'node:fs'
import { appendFile, mkdir, open, readFile, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { ChangesStatus, GitStatus, WorktreeStatus } from '../shared/protocol.ts'
import { run } from './proc.ts'

/** The git root of a directory (each worktree has its own), or the directory itself outside a repo. */
export function workspaceRoot(cwd: string): string {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || cwd
  } catch {
    return cwd
  }
}

const roots = new Map<string, string>()

/** workspaceRoot, looked up once per folder: it's asked about the same few over and over. */
export function rootOf(cwd: string): string {
  if (!roots.has(cwd)) roots.set(cwd, workspaceRoot(cwd))
  return roots.get(cwd)!
}

/** A folder Claude Code can't run in: removed (like a merged worktree), not a folder, or not readable. */
export function inaccessible(dir: string): boolean {
  try {
    if (!statSync(dir).isDirectory()) return true
    accessSync(dir, constants.R_OK | constants.X_OK)
    return false
  } catch {
    return true
  }
}

export const git = async (cwd: string, ...args: string[]) => (await run('git', args, { cwd })).stdout.trim()

/** Commits in a range, e.g. `@{upstream}..HEAD`. */
const count = async (path: string, range: string) => Number(await git(path, 'rev-list', '--count', range))

/** The branch checked out or, with HEAD detached, its commit's short hash: something to name it by and merge. */
const headName = async (path: string) => (await git(path, 'branch', '--show-current')) || git(path, 'rev-parse', '--short', 'HEAD')

/** Files with uncommitted changes, from `git status --porcelain`. */
const changed = (porcelain: string) => (porcelain ? porcelain.split('\n').length : 0)

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
export async function mainCheckout(path: string): Promise<string> {
  return dirname(resolve(path, await git(path, 'rev-parse', '--git-common-dir')))
}

export async function worktreeStatus(path: string): Promise<WorktreeStatus> {
  if (!WORKTREE_PATH.test(path)) throw new Error('Not a Claude Code worktree')
  const main = await mainCheckout(path)
  const [branch, status, base] = await Promise.all([headName(path), git(path, 'status', '--porcelain'), headName(main)])
  const unmerged = await count(path, `${await git(main, 'rev-parse', 'HEAD')}..HEAD`)
  return { path, branch, changes: changed(status), unmerged, base }
}

/** Uncommitted changes and commits not yet on the base, for any git checkout. Undefined outside a repo. */
export async function changesStatus(path: string): Promise<ChangesStatus | undefined> {
  if (WORKTREE_PATH.test(path)) {
    const wt = await worktreeStatus(path)
    return { branch: wt.branch, changes: wt.changes, base: wt.base, ahead: wt.unmerged }
  }
  const status = await git(path, 'status', '--porcelain').catch(() => undefined)
  if (status === undefined) return undefined
  const [branch, upstream] = await Promise.all([
    headName(path),
    git(path, 'rev-parse', '--abbrev-ref', '@{upstream}').catch(() => ''),
  ])
  const ahead = upstream ? await count(path, '@{upstream}..HEAD') : 0
  return { branch, changes: changed(status), base: upstream || undefined, ahead }
}

/**
 * Uncommitted lines added and removed, against HEAD, the way a diff would count them. New files count as all
 * added, read up to a point: big ones, binary ones and any past the first few hundred are left out.
 */
export async function lineChanges(path: string): Promise<{ added: number; removed: number }> {
  const [numstat, untracked] = await Promise.all([
    // A repo with no commits yet has no HEAD to compare with, so only what's staged counts.
    git(path, 'diff', 'HEAD', '--numstat').catch(() => git(path, 'diff', '--cached', '--numstat').catch(() => '')),
    git(path, 'ls-files', '--others', '--exclude-standard', '-z').catch(() => ''),
  ])
  let added = 0
  let removed = 0
  for (const line of numstat ? numstat.split('\n') : []) {
    // Binary files show as "-\t-".
    const [a, r] = line.split('\t')
    added += Number(a) || 0
    removed += Number(r) || 0
  }
  const files = untracked.split('\0').filter(Boolean).slice(0, 300)
  const counts = await Promise.all(files.map((f) => newLines(join(path, f))))
  return { added: added + counts.reduce((a, b) => a + b, 0), removed }
}

async function newLines(file: string): Promise<number> {
  const handle = await open(file, 'r').catch(() => undefined)
  if (!handle) return 0
  try {
    const { size } = await handle.stat()
    if (size > 1_000_000) return 0
    const buf = await handle.readFile()
    if (buf.subarray(0, 8000).includes(0)) return 0
    let n = 0
    for (const byte of buf) if (byte === 10) n++
    return n + (buf.length && buf[buf.length - 1] !== 10 ? 1 : 0)
  } finally {
    await handle.close()
  }
}

/** Where a checkout stands; fetching first, at most once a minute per repo, so "behind" is up to date. Undefined outside a repo. */
export async function gitStatus(path: string, fetch = false): Promise<GitStatus | undefined> {
  const status = await git(path, 'status', '--porcelain').catch(() => undefined)
  if (status === undefined) return undefined
  const common = resolve(path, await git(path, 'rev-parse', '--git-common-dir'))
  const [branch, remotes] = await Promise.all([git(path, 'branch', '--show-current'), git(path, 'remote')])
  const remoteList = remotes ? remotes.split('\n') : []
  const remote = remoteList.includes('origin') ? 'origin' : remoteList.length === 1 ? remoteList[0] : undefined
  if (fetch && remoteList.length) await fetchRepo(path, common, branch, remote)
  const upstream = await git(path, 'rev-parse', '--abbrev-ref', '@{upstream}').catch(() => '')
  const [ahead, behind] = upstream
    ? await Promise.all([count(path, '@{upstream}..HEAD'), count(path, 'HEAD..@{upstream}')])
    : [remote ? Number(await git(path, 'rev-list', '--count', 'HEAD', '--not', '--remotes')) : 0, 0]
  // Any linked worktree, not just Claude Code's; one with no commits yet has nothing to compare.
  const main = dirname(common)
  const linked = resolve(await git(path, 'rev-parse', '--show-toplevel')) !== resolve(main)
  const base = linked ? await baseStatus(path, main).catch(() => undefined) : undefined
  const [fetchedAt, lines] = await Promise.all([
    stat(join(common, 'FETCH_HEAD')).then((s) => s.mtimeMs, () => undefined),
    status ? lineChanges(path) : { added: 0, removed: 0 },
  ])
  return { branch, changes: changed(status), ...lines, upstream: upstream || undefined, ahead, behind, remote, base, fetchedAt }
}

/** How a linked worktree compares with the main checkout's HEAD. */
async function baseStatus(path: string, main: string): Promise<GitStatus['base']> {
  const [branch, head] = await Promise.all([headName(main), git(main, 'rev-parse', 'HEAD')])
  const [ahead, behind] = await Promise.all([count(path, `${head}..HEAD`), count(path, `HEAD..${head}`)])
  return { branch, ahead, behind }
}

/** Git that never stops to ask for a password, and gives up rather than hang on the network. */
const gitRemote = (cwd: string, ...args: string[]) =>
  run('git', args, { cwd, timeout: 60_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes' } }).catch(
    (err: { stderr?: string; killed?: boolean }) => {
      const said = err.stderr
        ?.split('\n')
        .filter((l) => l.trim() && !l.startsWith('hint:'))
        .map((l) => l.replace(/^(fatal|error): /, ''))
        .join('\n')
      throw new Error(err.killed ? 'git timed out' : said || 'git failed')
    },
  )

/** One fetch per repo at a time, and none if the last was under a minute ago. Failing (offline, no login) just leaves the counts as they were. */
const fetching = new Map<string, Promise<unknown>>()
async function fetchRepo(path: string, common: string, branch: string, fallback?: string): Promise<void> {
  const last = await stat(join(common, 'FETCH_HEAD')).then((s) => s.mtimeMs, () => 0)
  if (Date.now() - last < 60_000) return
  if (!fetching.has(common)) {
    const remote = (branch && (await git(path, 'config', `branch.${branch}.remote`).catch(() => ''))) || fallback
    const done = gitRemote(path, 'fetch', '--quiet', ...(remote ? [remote] : ['--all']))
      .catch(() => {})
      .finally(() => fetching.delete(common))
    fetching.set(common, done)
  }
  await fetching.get(common)
}

/** Push the branch, publishing it to the remote first if it has no upstream yet. */
export async function gitPush(path: string): Promise<void> {
  const status = await gitStatus(path)
  if (!status) throw new Error('Not a git repo')
  if (!status.branch) throw new Error('No branch is checked out')
  if (status.upstream) await gitRemote(path, 'push')
  else if (status.remote) await gitRemote(path, 'push', '--set-upstream', status.remote, status.branch)
  else throw new Error('This repo has no remote to push to')
}

/** Fast-forward to the upstream. Anything that would need a merge is refused, and left for Claude. */
export async function gitPull(path: string): Promise<void> {
  await gitRemote(path, 'pull', '--ff-only')
}

/**
 * Remove a linked worktree the way `git worktree remove` would: refused if it has
 * uncommitted changes. Its branch is deleted only if it's merged, so no commit
 * is ever lost.
 */
export async function removeWorktree(path: string): Promise<void> {
  const main = await mainCheckout(path)
  if (resolve(main) === resolve(path)) throw new Error("That's the repo's main checkout, not a worktree")
  const branch = await git(path, 'branch', '--show-current')
  // Claude Code locks worktrees it's using and doesn't always unlock them when the process ends.
  await git(main, 'worktree', 'unlock', path).catch(() => {})
  await git(main, 'worktree', 'remove', path).catch((err: { stderr?: string }) => {
    if (err.stderr?.includes('modified or untracked')) throw new Error('It has uncommitted changes. Commit or discard them first.')
    throw new Error(err.stderr?.trim().replace(/^fatal: /, '') || 'git worktree remove failed')
  })
  if (branch) await git(main, 'branch', '-d', branch).catch(() => {})
}

/** Why a checkout can't take a merge right now, if it can't: a merge already in progress, no branch, or uncommitted changes. */
export async function mergeBlocker(checkout: string): Promise<string | undefined> {
  const inProgress = await git(checkout, 'rev-parse', '-q', '--verify', 'MERGE_HEAD').then(() => true, () => false)
  if (inProgress) return `${checkout} is in the middle of a merge.`
  if (!(await git(checkout, 'branch', '--show-current'))) return `${checkout} has no branch checked out.`
  // Untracked files don't get in a merge's way unless the merge adds the same path, and git refuses that itself.
  const dirty = await git(checkout, 'status', '--porcelain', '--untracked-files=no')
  if (dirty) {
    // `git` trims the output, so the first line may have lost its leading status column.
    const files = dirty.split('\n').map((l) => l.trim().replace(/^\S+\s+/, ''))
    return `${checkout} has uncommitted changes (${files.slice(0, 5).join(', ')}${files.length > 5 ? ', …' : ''}).`
  }
  return undefined
}

/** Folderless chats run here, since Claude Code always needs a directory. It says there's no codebase. */
export function prepareScratch(dir: string): void {
  mkdirSync(dir, { recursive: true })
  if (!existsSync(join(dir, 'CLAUDE.md'))) {
    writeFileSync(
      join(dir, 'CLAUDE.md'),
      'Chats here are general questions, not tied to any project. There is no codebase to explore; just answer. This folder is shared scratch space for every such chat.\n',
    )
  }
}
