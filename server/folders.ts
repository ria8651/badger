import { existsSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { Checkout, FileEntry, Folder, Listing } from '../shared/protocol.ts'
import { run } from './proc.ts'
import { git, gitStatus, inaccessible, mainCheckout } from './workspace.ts'

/** A git command's output, or undefined if it failed, e.g. counting commits in a repo with none. */
const tryGit = (cwd: string, ...args: string[]) => git(cwd, ...args).catch(() => undefined)

/** The main checkout of the repo a directory is in, or undefined outside one. */
const repoOf = (dir: string) => mainCheckout(dir).catch(() => undefined)

/** A repo's working trees from `git worktree list`, main first, skipping bare repos and ones whose folder is gone. */
async function worktrees(main: string): Promise<{ path: string; branch: string; main: boolean }[]> {
  const out = (await tryGit(main, 'worktree', 'list', '--porcelain')) ?? ''
  const blocks = out.split('\n\n').map((block): Record<string, string> => Object.fromEntries(block.split('\n').map((line) => [line.split(' ')[0], line.slice(line.indexOf(' ') + 1)])))
  return (
    blocks
      // git lists the main working tree first.
      .map((w, i) => ({ path: w.worktree, branch: w.branch?.replace(/^refs\/heads\//, '') ?? '', main: i === 0, skip: 'bare' in w || 'prunable' in w }))
      .filter((w) => w.path && !w.skip && !inaccessible(w.path))
      .map(({ skip: _, ...w }) => w)
  )
}

async function checkout(path: string, branch: string, main: boolean, remotes: boolean): Promise<Checkout> {
  const [git, unpushed, committed] = await Promise.all([
    gitStatus(path).catch(() => undefined),
    remotes ? tryGit(path, 'rev-list', '--count', 'HEAD', '--not', '--remotes') : undefined,
    tryGit(path, 'log', '-1', '--format=%ct'),
  ])
  return {
    path,
    main,
    git: git ?? { branch, changes: 0, added: 0, removed: 0, ahead: 0, behind: 0 },
    unpushed: remotes ? Number(unpushed ?? 0) : null,
    committedAt: Number(committed ?? 0) * 1000,
  }
}

async function repoCheckouts(main: string): Promise<Checkout[]> {
  const [trees, remotes] = await Promise.all([worktrees(main), tryGit(main, 'remote')])
  const all = await Promise.all(trees.map((w) => checkout(w.path, w.branch, w.main, !!remotes)))
  return all.sort((a, b) => Number(b.main) - Number(a.main) || b.committedAt - a.committedAt)
}

/**
 * Every folder to offer for a new chat: the ones added by hand and the ones chats ran in, minus
 * hidden ones, most recently used first. Chats in a repo's worktree or subfolder count for the repo.
 */
export async function listFolders(used: Map<string, number>, added: Map<string, number>, hidden: Set<string>): Promise<Folder[]> {
  const folders = new Map<string, Folder>()
  const candidates = new Map(added)
  for (const [dir, at] of used) candidates.set(dir, Math.max(at, candidates.get(dir) ?? 0))
  await Promise.all(
    [...candidates].map(async ([dir, at]) => {
      if (inaccessible(dir)) return
      const path = (await repoOf(dir)) ?? dir
      if (hidden.has(path)) return
      const folder = folders.get(path) ?? { path, added: false, lastUsed: 0 }
      folder.added ||= added.has(dir)
      folder.lastUsed = Math.max(folder.lastUsed, at)
      folders.set(path, folder)
    }),
  )
  await Promise.all(
    [...folders.values()].map(async (f) => {
      if (existsSync(join(f.path, '.git'))) f.checkouts = await repoCheckouts(f.path)
    }),
  )
  return [...folders.values()].sort((a, b) => b.lastUsed - a.lastUsed)
}

/** Sizes on disk, kept a few minutes: `du` over a repo with node_modules takes a while. */
const sizes = new Map<string, { at: number; bytes: Promise<number> }>()
const SIZE_TTL_MS = 5 * 60 * 1000

/** Kilobytes under a folder, leaving out the folders in `exclude`. */
async function du(path: string, exclude: string[]): Promise<number> {
  // du exits non-zero over files it can't read, but still prints the total.
  const total = (args: string[]) =>
    run('du', ['-sk', ...args, path], { maxBuffer: 1 << 20 }).catch((err: { stdout?: string }) => ({ stdout: err.stdout ?? '' })).then(({ stdout }) => Number(stdout.split('\t')[0]) || 0)
  if (!exclude.length) return total([])
  // Subtracting doesn't work: pnpm hard-links node_modules, and du counts a file linked twice only once.
  // --exclude is GNU's; BSD du (macOS) doesn't have it, so there the total includes them.
  return (await total(exclude.map((dir) => `--exclude=${dir}`))) || total([])
}

/** Bytes a folder takes on disk. A main checkout's doesn't count worktrees kept inside it, which show their own. */
export function folderSize(path: string): Promise<number> {
  const cached = sizes.get(path)
  if (cached && Date.now() - cached.at < SIZE_TTL_MS) return cached.bytes
  const bytes = (async () => {
    const main = await repoOf(path)
    const nested = main && resolve(main) === resolve(path) ? (await worktrees(path)).filter((w) => !w.main && w.path.startsWith(`${path}/`)) : []
    return (await du(path, nested.map((w) => w.path))) * 1024
  })()
  sizes.set(path, { at: Date.now(), bytes })
  return bytes
}

/** Forget cached sizes in and under a folder, e.g. after removing a worktree. */
export function forgetSize(path: string): void {
  for (const key of sizes.keys()) if (key === path || key.startsWith(`${path}/`) || path.startsWith(`${key}/`)) sizes.delete(key)
}

const MAX_ENTRIES = 2000

/** A folder's contents for the file browser: folders first, then files, by name. */
export async function listDir(path: string, showHidden: boolean): Promise<Listing> {
  const dirents = await readdir(path, { withFileTypes: true })
  const shown = dirents.filter((d) => showHidden || !d.name.startsWith('.'))
  const entries = await Promise.all(
    shown.slice(0, MAX_ENTRIES).map(async (d): Promise<FileEntry> => {
      const full = join(path, d.name)
      // Follow symlinks, so a link to a folder opens like one; a broken link shows as a file.
      const info = d.isSymbolicLink() ? await stat(full).catch(() => undefined) : undefined
      const dir = info ? info.isDirectory() : d.isDirectory()
      if (dir) return { name: d.name, dir, git: existsSync(join(full, '.git')) }
      return { name: d.name, dir, size: (info ?? (await stat(full).catch(() => undefined)))?.size }
    }),
  )
  entries.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
  const parent = dirname(path)
  return { path, parent: parent === path ? null : parent, entries, truncated: shown.length > MAX_ENTRIES }
}
