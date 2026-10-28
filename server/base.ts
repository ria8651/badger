import { createHash } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import type { BaseChoices } from '../shared/protocol.ts'
import { run } from './proc.ts'

const git = async (cwd: string, ...args: string[]) => (await run('git', args, { cwd })).stdout.trim()

/** Where a branch picked by hand is kept: in the repo's own config, so every checkout of the branch has it. */
const configKey = (branch: string) => `branch.${branch}.badgerBase`

/** Branch names that are something to branch off and merge into, not work in progress. Remote names are stripped first. */
const TRUNK = /^(main|master|develop|development|dev|trunk|next|staging|stable|production)$|^(release|releases|rc|hotfix|support|stable)([/_-]|$)|^v?\d+(\.\d+)+|[-_.]rc\d*$/i

/** How many likely bases are compared, most recently committed first. */
const MAX_CANDIDATES = 30

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

/** Pass `wait` to wait on asking GitHub for the pull request the first time, rather than guess this once. */
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
    const pr = await prBase(path, branch, wait)
    if (pr) {
      const sha = await commitOf(path, pr)
      if (sha) return { branch: pr, sha, how: 'pr' }
    }
  }
  const { candidates, trunk } = await nearest(path, branch)
  if (trunk) return undefined
  const best = candidates[0]
  return best && { branch: best.branch, sha: best.sha, how: 'nearest' }
}

/** For picking a base by hand: the likely ones, nearest first, and every other branch by name. */
export async function baseChoices(path: string): Promise<BaseChoices> {
  const [branch, current] = await Promise.all([git(path, 'branch', '--show-current'), baseOf(path)])
  const [{ candidates }, refs] = await Promise.all([nearest(path, branch), git(path, 'for-each-ref', '--sort=-committerdate', '--format=%(refname:short)', 'refs/heads', 'refs/remotes')])
  const likely = new Set(candidates.map((c) => c.branch))
  const others = refs.split('\n').filter((r) => r && r !== branch && !likely.has(r) && !r.endsWith('/HEAD'))
  return {
    branch,
    current: current && { branch: current.branch, how: current.how },
    set: branch ? await git(path, 'config', '--get', configKey(branch)).catch(() => undefined) : undefined,
    likely: candidates.map(({ branch, ahead }) => ({ branch, ahead })),
    others,
  }
}

/** Picks the base by hand; `null` goes back to working it out, and `''` means none. */
export async function setBase(path: string, base: string | null): Promise<void> {
  const branch = await git(path, 'branch', '--show-current')
  if (!branch) throw new Error('No branch is checked out, so there is nothing to keep a base for')
  if (base === null) {
    await git(path, 'config', '--unset', configKey(branch)).catch(() => {})
    return
  }
  if (base && !(await commitOf(path, base))) throw new Error(`There's no branch called ${base}`)
  await git(path, 'config', configKey(branch), base)
}

const commitOf = (path: string, ref: string) => git(path, 'rev-parse', '-q', '--verify', `${ref}^{commit}`).catch(() => '')

interface Candidate {
  branch: string
  sha: string
  /** Commits on HEAD it doesn't have. */
  ahead: number
}

/** One answer per HEAD and set of branch tips, since nothing else changes it. */
const nearestCache = new Map<string, { candidates: Candidate[]; trunk: boolean }>()

/**
 * The likely bases, the one HEAD is fewest commits beyond first: the main checkout's branch, the remote's default
 * branch, and any named like a trunk or release, never the branch itself or a copy of it on a remote. Ties go to
 * the one with fewest commits HEAD doesn't have (so a release branch cut from develop wins over develop, for a
 * branch off it), then the main checkout's branch, then the default one, then a local branch over a remote one.
 * `trunk`: the branch is one of these itself.
 */
async function nearest(path: string, branch: string): Promise<{ candidates: Candidate[]; trunk: boolean }> {
  const common = resolve(path, await git(path, 'rev-parse', '--git-common-dir'))
  const main = dirname(common)
  const [head, refs, mainBranch, remoteHeads] = await Promise.all([
    git(path, 'rev-parse', '-q', '--verify', 'HEAD').catch(() => ''),
    git(path, 'for-each-ref', '--sort=-committerdate', '--format=%(refname)%00%(objectname)', 'refs/heads', 'refs/remotes'),
    git(main, 'branch', '--show-current').catch(() => ''),
    git(path, 'for-each-ref', '--format=%(symref:short)', 'refs/remotes/*/HEAD').catch(() => ''),
  ])
  const defaults = new Set(remoteHeads.split('\n').filter(Boolean).flatMap((r) => [r, r.slice(r.indexOf('/') + 1)]))
  const isTrunk = (name: string) => TRUNK.test(name) || defaults.has(name)
  const trunk = !!branch && isTrunk(branch)
  if (!head || trunk) return { candidates: [], trunk }

  const key = createHash('sha1').update(`${path}\0${branch}\0${head}\0${mainBranch}\0${remoteHeads}\0${refs}`).digest('hex')
  const hit = nearestCache.get(key)
  if (hit) return hit

  const remotes = new Set((await git(path, 'remote')).split('\n').filter(Boolean))
  const found: (Omit<Candidate, 'ahead'> & { name: string; rank: number })[] = []
  let named = 0
  for (const line of refs.split('\n')) {
    const [ref, sha] = line.split('\0')
    if (!ref || !sha) continue
    const local = ref.startsWith('refs/heads/')
    const short = ref.replace(/^refs\/(heads|remotes)\//, '')
    if (!local && short.endsWith('/HEAD')) continue
    const remote = local ? undefined : [...remotes].find((r) => short.startsWith(`${r}/`))
    const name = remote ? short.slice(remote.length + 1) : short
    if (name === branch) continue
    const rank = name === mainBranch ? 0 : defaults.has(short) || defaults.has(name) ? 1 : 2
    // The main checkout's and default branches always count; past them, only the most recent few.
    if (rank === 2 && (!isTrunk(name) || ++named > MAX_CANDIDATES)) continue
    found.push({ branch: short, name, sha, rank: rank * 2 + (local ? 0 : 1) })
  }
  const counted = await Promise.all(
    found.map(async (c) => {
      // Sharing no history with HEAD, it's no base at all.
      const fork = await git(path, 'merge-base', head, c.sha).catch(() => '')
      if (!fork) return undefined
      const [ahead, behind] = await Promise.all([git(path, 'rev-list', '--count', `${c.sha}..${head}`), git(path, 'rev-list', '--count', `${head}..${c.sha}`)])
      return { ...c, ahead: Number(ahead), behind: Number(behind) }
    }),
  )
  // A branch and its copies on remotes are one base: the copy HEAD is fewest commits beyond, the local one on a tie,
  // since one that's moved on since HEAD left it isn't any further from it.
  const byName = new Map<string, NonNullable<(typeof counted)[number]>>()
  for (const c of counted) {
    const had = c && byName.get(c.name)
    if (c && (!had || c.ahead < had.ahead || (c.ahead === had.ahead && c.rank < had.rank))) byName.set(c.name, c)
  }
  const ranked = [...byName.values()].sort((a, b) => a.ahead - b.ahead || a.behind - b.behind || a.rank - b.rank)
  const result = { candidates: ranked.map(({ branch, sha, ahead }) => ({ branch, sha, ahead })), trunk }
  if (nearestCache.size > 200) nearestCache.clear()
  nearestCache.set(key, result)
  return result
}

/** What GitHub said, per repo and branch, for a few minutes: the base of its open pull request, or none. */
const prCache = new Map<string, { at: number; base: Promise<string | undefined> }>()
const PR_MS = 5 * 60_000

/** The open pull request's base, as a branch here: the remote's copy if there is one, else the local one. Undefined without gh, a GitHub remote or a PR. */
async function prBase(path: string, branch: string, wait: boolean): Promise<string | undefined> {
  const key = `${resolve(path, await git(path, 'rev-parse', '--git-common-dir'))}\0${branch}`
  const hit = prCache.get(key)
  if (hit && Date.now() - hit.at < PR_MS) return wait ? hit.base : settled(hit.base)
  const base = (async () => {
    const { stdout } = await run('gh', ['pr', 'view', branch, '--json', 'baseRefName,state'], {
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
  prCache.set(key, { at: Date.now(), base })
  return wait ? base : settled(base)
}

/** A promise's value if it already has one, without waiting for it. */
const settled = <T,>(p: Promise<T | undefined>) => Promise.race([p, new Promise<undefined>((r) => setImmediate(() => r(undefined)))])
