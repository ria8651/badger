import { existsSync, statSync } from 'node:fs'
import { appendFile, mkdir, readdir, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { MovedFolder } from '../shared/protocol.ts'
import { git } from './repo.ts'
import { sessionInfo, transcriptPath } from './sessionInfo.ts'
import { projectsDir } from './sync.ts'
import { inaccessible } from './workspace.ts'

/** Whether `path` is `dir` or inside it. */
export const within = (path: string, dir: string) => path === dir || path.startsWith(`${dir}/`)

/** Where `path`, in or inside `from`, is once `from` is at `to`. */
const moved = (path: string, from: string, to: string) => to + path.slice(from.length)

/** Claude Code's project folder for a directory: its transcripts and memory. */
const projectOf = (dir: string) => join(projectsDir(), dir.replace(/[^a-zA-Z0-9]/g, '-').slice(0, 200))

/**
 * Moves or renames a folder chats ran in, or catches up with one already moved
 * by hand: whichever, by which of the two is there. Its git worktrees are
 * linked up again, the chats among `chats` that ran in or inside it are
 * stamped with where they are now, and Claude Code's memory for it goes too.
 * Chats are stamped the way Claude Code stamps one that moves (a `relocated`
 * line on the end of its transcript, which it and the SDK take as the chat's
 * folder from then on), so nothing in them is rewritten and a new folder at
 * the old path is left alone. Whether anything is working there is the
 * caller's to check first.
 */
export async function moveFolder(from: string, to: string, chats: string[]): Promise<MovedFolder & { stamped: string[] }> {
  if (from === to) throw new Error("That's where it is already")
  if (within(to, from)) throw new Error("A folder can't go inside itself")
  const there = !inaccessible(from)
  if (there) {
    if (existsSync(to)) throw new Error(`${to} is there already`)
    if (!statSync(dirname(to), { throwIfNoEntry: false })?.isDirectory()) throw new Error(`${dirname(to)} isn't a folder`)
    await rename(from, to).catch((err: NodeJS.ErrnoException) => {
      throw err.code === 'EXDEV' ? new Error(`${dirname(to)} is on another disk, and a folder can only be moved within one`) : err
    })
  } else if (inaccessible(to)) {
    throw new Error(`Neither ${from} nor ${to} is there`)
  }

  // A repo moved, or folders of them: each is looked at, and the folders right inside it.
  const checkouts = [to, ...(await readdir(to, { withFileTypes: true }).catch(() => [])).filter((e) => e.isDirectory()).map((e) => join(to, e.name))]
  let worktrees = 0
  for (const dir of checkouts) worktrees += await repairWorktrees(dir, from, to)

  const stamped: string[] = []
  for (const id of chats) {
    const cwd = (await sessionInfo(id))?.cwd
    const path = cwd && within(cwd, from) && (await transcriptPath(id))
    if (!path) continue
    await appendFile(path, `${JSON.stringify({ type: 'relocated', sessionId: id, relocatedCwd: moved(cwd, from, to) })}\n`)
    stamped.push(id)
  }

  // Claude Code keeps memory by the folder of the repo it's for, so the same folders are looked at as for worktrees.
  let memory = 0
  for (const dir of checkouts) {
    const old = join(projectOf(moved(dir, to, from)), 'memory')
    const now = join(projectOf(dir), 'memory')
    if (!existsSync(old) || existsSync(now)) continue
    await mkdir(dirname(now), { recursive: true })
    await rename(old, now)
    memory++
  }

  return { moved: there, chats: stamped.length, worktrees, memory, stamped }
}

/**
 * Links a checkout and its worktrees up again once some of them have moved, as
 * `git worktree repair` does when told where they are now. A repo's main
 * checkout still has its worktrees down where they were; one of them moved on
 * its own just needs its repo told. Returns how many were put right.
 */
async function repairWorktrees(dir: string, from: string, to: string): Promise<number> {
  const dotGit = statSync(join(dir, '.git'), { throwIfNoEntry: false })
  if (!dotGit) return 0
  if (dotGit.isFile()) return (await git(dir, 'worktree', 'repair').then(() => 1, () => 0))
  const list = await git(dir, 'worktree', 'list', '--porcelain').catch(() => '')
  const paths = list.split('\n').flatMap((l) => (l.startsWith('worktree ') ? [l.slice('worktree '.length)] : []))
  // The first is the main checkout itself. Those that moved with it are named; the rest it finds.
  const linked = paths.slice(1)
  const movedHere = linked.flatMap((p) => (within(p, from) ? [moved(p, from, to)] : []))
  return git(dir, 'worktree', 'repair', ...movedHere).then(() => linked.length, () => 0)
}
