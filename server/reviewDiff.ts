import { createHash } from 'node:crypto'
import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { ReviewCommit, ReviewDiff, ReviewFile, ReviewHunk, ReviewScope } from '../shared/protocol.ts'
import { run } from './proc.ts'
import { WORKTREE_PATH, git, mainCheckout } from './workspace.ts'

/** Git's tree with nothing in it, for diffing a root commit against. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8b69288fbe4904b'
/** Lines of patch a file can have before it's left out, and the whole diff's limit. */
const FILE_LINES = 4000
const TOTAL_BYTES = 8_000_000
const GENERATED = /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|Cargo\.lock|poetry\.lock|go\.sum|[^/]+\.min\.(js|css)|[^/]+\.map)$/

/**
 * The working tree as a tree object, untracked files included and ignored ones not, without touching
 * the real index: `git add -A` into a copy of it, so unchanged files cost a stat each.
 */
async function snapshot(path: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'badger-review-'))
  const index = join(dir, 'index')
  try {
    const real = resolve(path, await git(path, 'rev-parse', '--git-path', 'index'))
    await copyFile(real, index).catch(() => {})
    const env = { ...process.env, GIT_INDEX_FILE: index }
    await run('git', ['add', '-A'], { cwd: path, env })
    return (await run('git', ['write-tree'], { cwd: path, env })).stdout.trim()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** What `base` compares with: the main checkout's HEAD in a worktree, else the upstream. */
async function baseOf(path: string): Promise<{ label: string; sha: string } | undefined> {
  if (WORKTREE_PATH.test(path)) {
    const main = await mainCheckout(path)
    const [branch, sha] = await Promise.all([git(main, 'branch', '--show-current'), git(main, 'rev-parse', 'HEAD')])
    return { label: branch || sha.slice(0, 7), sha }
  }
  const upstream = await git(path, 'rev-parse', '--abbrev-ref', '@{upstream}').catch(() => '')
  if (!upstream) return undefined
  return { label: upstream, sha: await git(path, 'rev-parse', '@{upstream}') }
}

async function commitsSince(path: string, from: string): Promise<ReviewCommit[]> {
  const out = await git(path, 'log', '--format=%H%x1f%s%x1f%an%x1f%at', `${from}..HEAD`).catch(() => '')
  return out
    ? out.split('\n').map((l) => {
        const [sha, subject, author, at] = l.split('\x1f')
        return { sha, subject, author, date: Number(at) * 1000 }
      })
    : []
}

/** From what a hunk says, not where: moving it down the file keeps its id, changing a line in it doesn't. */
const hunkId = (path: string, content: string) => 'h' + createHash('sha1').update(path).update('\0').update(content).digest('hex').slice(0, 8)

/** A file's patch, from its first @@, as hunks. The same lines twice in one file get -2, -3. */
function hunksOf(path: string, body: string[]): ReviewHunk[] {
  const hunks: ReviewHunk[] = []
  const seen = new Map<string, number>()
  let start = 0
  for (let i = 1; i <= body.length; i++) {
    if (i < body.length && !body[i].startsWith('@@')) continue
    const lines = body.slice(start, i)
    const base = hunkId(path, lines.slice(1).join('\n'))
    const n = (seen.get(base) ?? 0) + 1
    seen.set(base, n)
    hunks.push({ id: n === 1 ? base : `${base}-${n}`, patch: lines.join('\n') })
    start = i
  }
  return hunks
}

/** Splits `git diff` output into its files. */
function parsePatch(out: string): ReviewFile[] {
  const files: ReviewFile[] = []
  let total = 0
  for (const chunk of out.split(/^(?=diff --git )/m)) {
    if (!chunk.startsWith('diff --git ')) continue
    const lines = chunk.split('\n')
    const header: string[] = []
    let i = 0
    while (i < lines.length && !lines[i].startsWith('@@') && !lines[i].startsWith('Binary files')) header.push(lines[i++])
    const field = (prefix: string) => header.find((l) => l.startsWith(prefix))?.slice(prefix.length)
    const binary = lines[i]?.startsWith('Binary files') ?? false
    // `diff --git a/x b/x` is ambiguous with spaces in paths, so the rename and ---/+++ lines come first.
    const [, a = '', b = ''] = /^diff --git a\/(.*) b\/(.*)$/.exec(header[0]) ?? []
    const minus = field('--- ')
    const plus = field('+++ ')
    const oldPath = field('rename from ') ?? (minus && minus !== '/dev/null' ? minus.replace(/^a\//, '') : a)
    const path = field('rename to ') ?? (plus && plus !== '/dev/null' ? plus.replace(/^b\//, '') : minus && minus !== '/dev/null' ? oldPath : b)
    const status = field('new file mode') !== undefined
      ? 'added'
      : field('deleted file mode') !== undefined
        ? 'deleted'
        : field('rename to ') !== undefined
          ? 'renamed'
          : 'modified'
    const [, , to] = /^([0-9a-f]+)\.\.([0-9a-f]+)/.exec(field('index ') ?? '') ?? []
    const body = binary ? [] : lines.slice(i)
    while (body.length && body[body.length - 1] === '') body.pop()
    let added = 0
    let removed = 0
    for (const l of body) {
      if (l.startsWith('+')) added++
      else if (l.startsWith('-')) removed++
    }
    const size = body.reduce((n, l) => n + l.length + 1, 0)
    const truncated = body.length > FILE_LINES || total + size > TOTAL_BYTES
    if (!truncated) total += size
    files.push({
      path,
      ...(status === 'renamed' ? { oldPath } : {}),
      status,
      added,
      removed,
      binary,
      hunks: truncated || !body.length ? [{ id: hunkId(path, [status, oldPath, to ?? ''].join('\0')), patch: '' }] : hunksOf(path, body),
      ...(truncated ? { truncated } : {}),
      ...(GENERATED.test(path) ? { generated: true } : {}),
      ...(status !== 'deleted' && to && !/^0+$/.test(to) ? { blob: to } : {}),
    })
  }
  return files
}

/** The changes in a checkout for a review: see ReviewScope. `context` is lines around each change, as `-U`. */
export async function reviewDiff(path: string, scope: ReviewScope, context = 3): Promise<ReviewDiff> {
  const [branch, tree, base] = await Promise.all([git(path, 'branch', '--show-current'), snapshot(path), baseOf(path).catch(() => undefined)])
  const head = await git(path, 'rev-parse', '-q', '--verify', 'HEAD').catch(() => '')
  const forkPoint = base && head ? await git(path, 'merge-base', head, base.sha).catch(() => '') : ''
  const commits = forkPoint ? await commitsSince(path, forkPoint) : []

  let from: string
  let to = tree
  switch (scope.kind) {
    case 'base':
      from = forkPoint || head || EMPTY_TREE
      break
    case 'uncommitted':
      from = head || EMPTY_TREE
      break
    case 'commit':
      to = scope.sha
      from = await git(path, 'rev-parse', '-q', '--verify', `${scope.sha}^`).catch(() => EMPTY_TREE)
      break
    case 'since':
      from = scope.tree
      break
  }
  const { stdout } = await run(
    'git',
    ['-c', 'core.quotePath=false', 'diff', '--no-color', '--no-ext-diff', '--full-index', '-M', `-U${Math.max(0, Math.min(context, 100_000))}`, from, to],
    { cwd: path, maxBuffer: 256 * 1024 * 1024 },
  )
  return { branch, base: base?.label, commits, snapshot: tree, files: parsePatch(stdout) }
}
