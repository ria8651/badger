import { createHash } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import type { BaseChoices } from '../shared/protocol.ts'
import { run } from './proc.ts'

const git = async (cwd: string, ...args: string[]) => (await run('git', args, { cwd })).stdout.trim()

/** Where a branch picked by hand is kept: in the repo's own config, so every checkout of the branch has it. */
const configKey = (branch: string) => `branch.${branch}.badgerBase`

/**
 * Branch names that are something to branch off and merge into, not work in progress. Remote names are stripped first.
 * Not hotfix/…: those are worked on, and merged like any other branch.
 */
const TRUNK = /^(main|master|develop|development|dev|trunk|next|staging|stable|production)$|^(release|releases|rc|support|stable)([/_-]|$)|^v?\d+(\.\d+)+|[-_.]rc\d*$/i

/** How many likely bases named like trunks are compared, most recently committed first, past the main checkout's and default ones. */
const MAX_CANDIDATES = 12

/** How long a caller that waits on GitHub for a pull request's base waits, before going on without it this once. */
const PR_WAIT_MS = 2000

/**
 * What a branch is compared with: the commits it has that the base doesn't are its work, and a diff review
 * starts from where it left the base. Picked by hand (`set`), else the base of its open pull request (`pr`),
 * else the likely base it's fewest commits beyond (`nearest`). A branch that is itself one to branch off,
 * like develop or a release branch, gets one only by hand.
 */
export interface Base {
  /** As git names it: develop, or origin/release/2.5 for one only on the remote. */
  branch: string
  sha: string
  how: 'set' | 'pr' | 'nearest'
}

/** Pass `wait` to wait, briefly, on asking GitHub for the pull request the first time, rather than guess this once. */
export async function baseOf(path: string, wait = false): Promise<Base | undefined> {
  const branch = await git(path, 'branch', '--show-current')
  if (branch) {
    const set = await git(path, 'config', '--get', configKey(branch)).catch(() => undefined)
    if (set !== undefined) {
      // Set to nothing: no base, on purpose.
      if (!set) return undefined
      const sha = await commitOf(path, set)
      if (sha) return { branch: set, sha, how: 'set' }
    }
  }
  const { candidates, trunk } = await nearest(path, branch)
  if (trunk) return undefined
  const pr = branch ? await prBase(path, branch, wait) : undefined
  const prSha = pr && (await commitOf(path, pr))
  if (pr && prSha) return { branch: pr, sha: prSha, how: 'pr' }
  const best = candidates[0]
  return best && { branch: best.branch, sha: best.sha, how: 'nearest' }
}

/** For picking a base by hand: the likely ones, nearest first, and every other branch by name. */
export async function baseChoices(path: string): Promise<BaseChoices> {
  const [branch, current] = await Promise.all([git(path, 'branch', '--show-current'), baseOf(path)])
  const [{ candidates }, refs] = await Promise.all([nearest(path, branch), git(path, 'for-each-ref', '--sort=-committerdate', '--format=%(refname)', 'refs/heads', 'refs/remotes')])
  const likely = new Set(candidates.map((c) => c.branch))
  const others = refs
    .split('\n')
    // By its full name, since a remote's HEAD shortens to just the remote's name.
    .filter((r) => r && !/^refs\/remotes\/[^/]+\/HEAD$/.test(r))
    .map(shortName)
    .filter((r) => r !== branch && !likely.has(r))
  return {
    branch,
    current: current && { branch: current.branch, how: current.how },
    set: branch ? await git(path, 'config', '--get', configKey(branch)).catch(() => undefined) : undefined,
    likely: candidates.map(({ branch, ahead }) => ({ branch, ahead })),
    others,
  }
}

/** Picks the base by hand: a branch, here or on a remote; `null` goes back to working it out, and `''` means none. */
export async function setBase(path: string, base: string | null): Promise<void> {
  const branch = await git(path, 'branch', '--show-current')
  if (!branch) throw new Error('No branch is checked out, so there is nothing to keep a base for')
  if (base === null) {
    await git(path, 'config', '--unset', configKey(branch)).catch(() => {})
    return
  }
  // A branch, not any revision: HEAD~1 would move with every commit.
  const isBranch = async (ref: string) => git(path, 'show-ref', '--verify', '--quiet', ref).then(() => true, () => false)
  if (base && !(await isBranch(`refs/heads/${base}`)) && !(await isBranch(`refs/remotes/${base}`))) throw new Error(`There's no branch called ${base}`)
  await git(path, 'config', configKey(branch), base)
}

const commitOf = (path: string, ref: string) => git(path, 'rev-parse', '-q', '--verify', `${ref}^{commit}`).catch(() => '')
const shortName = (ref: string) => ref.replace(/^refs\/(heads|remotes)\//, '')

interface Candidate {
  branch: string
  sha: string
  /** Commits on HEAD it doesn't have. */
  ahead: number
}

/** One answer per HEAD and set of likely bases' tips, since nothing else changes it: shared while it's worked out. */
const nearestCache = new Map<string, Promise<Candidate[]>>()

/**
 * The likely bases, the one HEAD is fewest commits beyond first: the main checkout's branch, the remote's default
 * branch, and any named like a trunk or release, never the branch itself or a copy of it on a remote. Ties go to
 * the one with fewest commits HEAD doesn't have (so a release branch cut from develop wins over develop, for a
 * branch off it), then the main checkout's branch, then the default one, then a local branch over a remote one.
 * `trunk`: the branch is one of these itself.
 */
async function nearest(path: string, branch: string): Promise<{ candidates: Candidate[]; trunk: boolean }> {
  const common = resolve(path, await git(path, 'rev-parse', '--git-common-dir'))
  const [head, refs, mainBranch, remoteHeads, remoteList] = await Promise.all([
    git(path, 'rev-parse', '-q', '--verify', 'HEAD').catch(() => ''),
    git(path, 'for-each-ref', '--sort=-committerdate', '--format=%(refname)%00%(objectname)', 'refs/heads', 'refs/remotes'),
    git(dirname(common), 'branch', '--show-current').catch(() => ''),
    git(path, 'for-each-ref', '--format=%(symref:short)', 'refs/remotes/*/HEAD').catch(() => ''),
    git(path, 'remote').catch(() => ''),
  ])
  const defaults = new Set(remoteHeads.split('\n').filter(Boolean).flatMap((r) => [r, r.slice(r.indexOf('/') + 1)]))
  const isTrunk = (name: string) => TRUNK.test(name) || defaults.has(name)
  const trunk = !!branch && isTrunk(branch)
  if (!head || trunk) return { candidates: [], trunk }

  const remotes = remoteList.split('\n').filter(Boolean)
  const found: (Omit<Candidate, 'ahead'> & { name: string; rank: number })[] = []
  let named = 0
  for (const line of refs.split('\n')) {
    const [ref, sha] = line.split('\0')
    if (!ref || !sha) continue
    const local = ref.startsWith('refs/heads/')
    const short = shortName(ref)
    if (!local && short.endsWith('/HEAD')) continue
    const remote = local ? undefined : remotes.find((r) => short.startsWith(`${r}/`))
    const name = remote ? short.slice(remote.length + 1) : short
    if (name === branch) continue
    const rank = name === mainBranch ? 0 : defaults.has(short) || defaults.has(name) ? 1 : 2
    // The main checkout's and default branches always count; past them, only the most recent few.
    if (rank === 2 && (!isTrunk(name) || ++named > MAX_CANDIDATES)) continue
    found.push({ branch: short, name, sha, rank: rank * 2 + (local ? 0 : 1) })
  }

  // Only what's compared goes in the key: a commit on some other branch, say another worktree's, changes nothing here.
  const key = createHash('sha1').update(`${path}\0${head}\0${found.map((c) => `${c.branch}\0${c.sha}\0${c.rank}`).join('\0')}`).digest('hex')
  let candidates = nearestCache.get(key)
  if (!candidates) {
    candidates = rank(path, head, found)
    if (nearestCache.size > 200) nearestCache.clear()
    nearestCache.set(key, candidates)
    candidates.catch(() => nearestCache.delete(key))
  }
  return { candidates: await candidates, trunk }
}

/** The likely bases in order (see nearest), each counted with one git call. */
async function rank(path: string, head: string, found: { branch: string; name: string; sha: string; rank: number }[]): Promise<Candidate[]> {
  const counted = await Promise.all(
    found.map(async (c) => {
      // Its commits HEAD doesn't have, then HEAD's it doesn't. One that shares no history counts all of HEAD's, so comes last.
      const [behind, ahead] = (await git(path, 'rev-list', '--left-right', '--count', `${c.sha}...${head}`)).split(/\s+/).map(Number)
      return { ...c, ahead, behind }
    }),
  )
  // A branch and its copies on remotes are one base: the copy HEAD is fewest commits beyond, the local one on a tie,
  // since one that's moved on since HEAD left it isn't any further from it.
  const byName = new Map<string, (typeof counted)[number]>()
  for (const c of counted) {
    const had = byName.get(c.name)
    if (!had || c.ahead < had.ahead || (c.ahead === had.ahead && c.rank < had.rank)) byName.set(c.name, c)
  }
  return [...byName.values()].sort((a, b) => a.ahead - b.ahead || a.behind - b.behind || a.rank - b.rank).map(({ branch, sha, ahead }) => ({ branch, sha, ahead }))
}

/** What GitHub said, per repo and branch, for a few minutes: the base of its open pull request, or none. */
const prCache = new Map<string, { at: number; base: Promise<string | undefined> }>()
const PR_MS = 5 * 60_000

/**
 * The open pull request's base, as a branch here: the remote's copy if there is one, else the local one. Undefined
 * without gh, a GitHub remote or a PR. gh finds the PR from the branch's own remote and upstream, so another fork's
 * PR from a branch of the same name isn't taken for it.
 */
async function prBase(path: string, branch: string, wait: boolean): Promise<string | undefined> {
  const [common, urls] = await Promise.all([git(path, 'rev-parse', '--git-common-dir'), git(path, 'remote', '-v').catch(() => '')])
  if (!/github/i.test(urls)) return undefined
  const key = `${resolve(path, common)}\0${branch}`
  let hit = prCache.get(key)
  if (!hit || Date.now() - hit.at > PR_MS) {
    const base = (async () => {
      const { stdout } = await run('gh', ['pr', 'view', '--json', 'baseRefName,state'], {
        cwd: path,
        timeout: 15_000,
        env: { ...process.env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' },
      })
      const pr = JSON.parse(stdout) as { baseRefName?: string; state?: string }
      if (pr.state !== 'OPEN' || !pr.baseRefName) return undefined
      const remote = (await git(path, 'config', `branch.${branch}.remote`).catch(() => '')) || 'origin'
      for (const ref of [`${remote}/${pr.baseRefName}`, pr.baseRefName]) if (await commitOf(path, ref)) return ref
      return undefined
    })().catch(() => undefined)
    prCache.set(key, (hit = { at: Date.now(), base }))
  }
  // Waiting, only so long: GitHub slow or out of reach mustn't hold up a review; a later ask picks the answer up.
  return Promise.race([hit.base, new Promise<undefined>((r) => (wait ? setTimeout(() => r(undefined), PR_WAIT_MS) : setImmediate(() => r(undefined))))])
}
