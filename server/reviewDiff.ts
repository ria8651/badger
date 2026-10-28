import { createHash } from 'node:crypto'
import { copyFile, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { ReviewCommit, ReviewDiff, ReviewFile, ReviewHunk, ReviewScope } from '../shared/protocol.ts'
import { run } from './proc.ts'
import { baseOf } from './base.ts'
import { git } from './workspace.ts'

/** Lines of patch a file can have before it's left out, and the whole diff's limit. */
const FILE_LINES = 4000
const TOTAL_BYTES = 8_000_000
/** An untracked file bigger than this is listed, too big to show, rather than hashed into the repo on every read. */
const UNTRACKED_BYTES = 1_000_000
/** The most git diff may print before the review gives up on it. */
const MAX_OUTPUT = 256 * 1024 * 1024
/** How long one read of a checkout's changes serves others asking the same, e.g. a guide written a group at a time. */
const REUSE_MS = 1500
const GENERATED = /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|Cargo\.lock|poetry\.lock|go\.sum|[^/]+\.min\.(js|css)|[^/]+\.map)$/

/** Git's tree with nothing in it, for diffing a repo with no commits, or a root commit, against. Written, since a repo needn't have it. */
const emptyTree = async (path: string) => (await run('git', ['hash-object', '-w', '-t', 'tree', '/dev/null'], { cwd: path })).stdout.trim()

/**
 * The working tree as a tree object, untracked files included and ignored ones not, without touching
 * the real index: `git add -A` into a copy of it, so unchanged files cost a stat each. Untracked files
 * too big to show are left out, and listed with their size and time so a change to one still shows.
 */
async function snapshot(path: string): Promise<{ tree: string; big: { path: string; size: number; mtime: number }[] }> {
  const dir = await mkdtemp(join(tmpdir(), 'badger-review-'))
  const index = join(dir, 'index')
  try {
    const real = resolve(path, await git(path, 'rev-parse', '--git-path', 'index'))
    await copyFile(real, index).catch(() => {})
    const env = { ...process.env, GIT_INDEX_FILE: index }
    const top = await git(path, 'rev-parse', '--show-toplevel')
    const untracked = (await run('git', ['ls-files', '-o', '--exclude-standard', '-z', '--full-name'], { cwd: top, maxBuffer: 64 * 1024 * 1024 })).stdout.split('\0').filter(Boolean)
    const big: { path: string; size: number; mtime: number }[] = []
    for (const file of untracked) {
      const s = await stat(join(top, file)).catch(() => undefined)
      if (s && s.size > UNTRACKED_BYTES) big.push({ path: file, size: s.size, mtime: s.mtimeMs })
    }
    await run('git', ['add', '-A', '--', '.', ...big.map((b) => `:(top,exclude,literal)${b.path}`)], { cwd: top, env })
    return { tree: (await run('git', ['write-tree'], { cwd: top, env })).stdout.trim(), big }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** A path as git prints it in a patch: C-quoted if it has odd characters, and on ---/+++ lines followed by a tab if it has a space. */
function gitPath(raw: string): string {
  const s = raw.replace(/\t$/, '')
  if (!s.startsWith('"') || !s.endsWith('"')) return s
  const bytes: number[] = []
  const body = s.slice(1, -1)
  for (let i = 0; i < body.length; i++) {
    const c = body[i]
    if (c !== '\\') {
      bytes.push(...Buffer.from(c))
      continue
    }
    const next = body[++i]
    if (/[0-7]/.test(next)) {
      bytes.push(parseInt(body.slice(i, i + 3), 8))
      i += 2
    } else bytes.push(({ n: 10, t: 9, r: 13, a: 7, b: 8, f: 12, v: 11 } as Record<string, number>)[next] ?? next.charCodeAt(0))
  }
  return Buffer.from(bytes).toString('utf8')
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
    const quoted = /^diff --git ("(?:[^"\\]|\\.)*"|a\/.*?) ("(?:[^"\\]|\\.)*"|b\/.*)$/.exec(header[0]) ?? []
    const a = gitPath(quoted[1] ?? '').replace(/^a\//, '')
    const b = gitPath(quoted[2] ?? '').replace(/^b\//, '')
    const minus = field('--- ') && gitPath(field('--- ')!)
    const plus = field('+++ ') && gitPath(field('+++ ')!)
    const renamedFrom = field('rename from ') && gitPath(field('rename from ')!)
    const renamedTo = field('rename to ') && gitPath(field('rename to ')!)
    const oldPath = renamedFrom ?? (minus && minus !== '/dev/null' ? minus.replace(/^a\//, '') : a)
    const path = renamedTo ?? (plus && plus !== '/dev/null' ? plus.replace(/^b\//, '') : minus && minus !== '/dev/null' ? oldPath : b)
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

const recent = new Map<string, { at: number; diff: Promise<ReviewDiff> }>()

/**
 * The changes in a checkout for a review: see ReviewScope. `context` is lines around each change, as `-U`.
 * Asked again for the same within REUSE_MS, the one read serves both.
 */
export function reviewDiff(path: string, scope: ReviewScope, context = 3): Promise<ReviewDiff> {
  const key = JSON.stringify([path, scope, context])
  const now = Date.now()
  for (const [k, r] of recent) if (now - r.at > REUSE_MS) recent.delete(k)
  const hit = recent.get(key)
  if (hit) return hit.diff
  const diff = readDiff(path, scope, context)
  recent.set(key, { at: now, diff })
  diff.catch(() => recent.delete(key))
  return diff
}

async function readDiff(path: string, scope: ReviewScope, context: number): Promise<ReviewDiff> {
  const [branch, { tree, big }, base] = await Promise.all([git(path, 'branch', '--show-current'), snapshot(path), baseOf(path, true).catch(() => undefined)])
  const head = await git(path, 'rev-parse', '-q', '--verify', 'HEAD').catch(() => '')
  const forkPoint = base && head ? await git(path, 'merge-base', head, base.sha).catch(() => '') : ''
  const commits = forkPoint ? await commitsSince(path, forkPoint) : []

  let from: string
  let to = tree
  switch (scope.kind) {
    case 'base':
      from = forkPoint || head || (await emptyTree(path))
      break
    case 'uncommitted':
      from = head || (await emptyTree(path))
      break
    case 'commit':
      to = scope.sha
      from = await git(path, 'rev-parse', '-q', '--verify', `${scope.sha}^`).catch(() => emptyTree(path))
      break
    case 'since':
      from = scope.tree
      break
  }
  const { stdout } = await run(
    'git',
    ['-c', 'core.quotePath=false', 'diff', '--no-color', '--no-ext-diff', '--full-index', '-M', `-U${Math.max(0, Math.min(context, 100_000))}`, from, to],
    { cwd: path, maxBuffer: MAX_OUTPUT },
  ).catch((err) => {
    if ((err as { code?: string }).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw new Error(`These changes are too big to review here: git's diff of them is over ${MAX_OUTPUT >> 20} MB.`)
    if (scope.kind === 'since' && /bad object/.test(String((err as Error).message))) throw new Error('That earlier snapshot of the changes has been cleared away by git, so what changed since it can\'t be shown.')
    throw err
  })
  const files = parsePatch(stdout)
  // Too big to have been put in the snapshot, so not in the diff: listed, to be read some other way. Only the working tree has them.
  for (const b of to === tree ? big : []) {
    if (files.some((f) => f.path === b.path)) continue
    files.push({ path: b.path, status: 'added', added: 0, removed: 0, binary: false, truncated: true, hunks: [{ id: hunkId(b.path, `untracked\0${b.size}\0${b.mtime}`), patch: '' }] })
  }
  return { branch, base: base?.branch, baseHow: base?.how, commits, snapshot: tree, files }
}
