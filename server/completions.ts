import { readFile, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, relative } from 'node:path'
import type { SlashCommand } from '@anthropic-ai/claude-agent-sdk'
import type { CheckoutFiles, CommandInfo, CommandSource } from '../shared/protocol.ts'
import { oneOff } from './claudeProbe.ts'
import { run } from './proc.ts'

/** How long a folder's commands or files are reused before they're looked up again. */
const FRESH_MS = 30_000

/** Looked up once per folder at a time, and reused for a while; a failed lookup is retried next time. */
function cached<T>(load: (cwd: string) => Promise<T>) {
  const entries = new Map<string, { at: number; value: Promise<T> }>()
  return (cwd: string): Promise<T> => {
    // Old ones go, so folders looked in once aren't kept for good.
    for (const [key, { at }] of entries) if (Date.now() - at >= FRESH_MS) entries.delete(key)
    const hit = entries.get(cwd)
    if (hit) return hit.value
    const value = load(cwd)
    entries.set(cwd, { at: Date.now(), value })
    value.catch(() => entries.get(cwd)?.value === value && entries.delete(cwd))
    return value
  }
}

/**
 * The slash commands and skills a chat in `cwd` can run, each with where it's from. Claude Code lists only the one
 * that runs when names clash, and says where it's from at the end of its description; the ones it hides are found
 * on disk and listed too, marked shadowed, since a near-twin in another place is what makes picking hard.
 */
export const listCommands = cached(async (cwd: string): Promise<CommandInfo[]> => {
  const [listed, onDisk] = await Promise.all([
    oneOff({ cwd, settingSources: ['user', 'project', 'local'] }, async (q) => (await q.initializationResult()).commands),
    commandFiles(cwd),
  ])
  const commands = listed.filter((c) => !c.name.startsWith('__')).map(describe)
  for (const file of onDisk) {
    const live = commands.find((c) => c.name === file.name && !c.shadowed)
    // Of two project ones, the nearest is taken to be the one that runs; it comes first.
    if (live && live.source === file.source && !live.path) live.path = file.path
    else if (live) commands.push({ ...file, shadowed: true })
  }
  return commands
})

/** Where Claude Code says a command is from: its flag for its own, else a note it adds to the description. */
function describe(c: SlashCommand): CommandInfo {
  const base = { name: c.name, ...(c.argumentHint ? { argumentHint: c.argumentHint } : {}) }
  if (c.builtin) return { ...base, description: c.description, source: 'builtin' }
  const suffix = / \((user|project|claude\.ai sync|MCP)\)$/.exec(c.description)
  if (suffix) {
    const source: CommandSource = suffix[1] === 'claude.ai sync' ? 'synced' : suffix[1] === 'MCP' ? 'mcp' : (suffix[1] as CommandSource)
    const origin = source === 'mcp' && c.name.includes(':') ? c.name.split(':')[0] : undefined
    return { ...base, description: c.description.slice(0, suffix.index), source, ...(origin ? { origin } : {}) }
  }
  const plugin = c.name.includes(':') ? c.name.split(':')[0] : undefined
  if (plugin && c.description.startsWith(`(${plugin}) `)) return { ...base, description: c.description.slice(plugin.length + 3), source: 'plugin', origin: plugin }
  // Skills that come with Claude Code are only told apart by having no note.
  return { ...base, description: c.description, source: 'builtin' }
}

/** The skill and command files for `cwd`: the user's, then each project folder's from `cwd` up. */
async function commandFiles(cwd: string): Promise<(CommandInfo & { path: string })[]> {
  const user = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
  const project: string[] = []
  for (let dir = cwd; ; dir = dirname(dir)) {
    if (join(dir, '.claude') !== user) project.push(join(dir, '.claude'))
    if (dirname(dir) === dir) break
  }
  const found = await Promise.all([inClaudeDir(user, 'user'), ...project.map((d) => inClaudeDir(d, 'project'))])
  return found.flat()
}

/** `skills/<name>/SKILL.md` and `commands/**\/*.md`, the latter named by their path with `:` between folders. */
async function inClaudeDir(dir: string, source: 'user' | 'project'): Promise<(CommandInfo & { path: string })[]> {
  const out: (CommandInfo & { path: string })[] = []
  const skills = await readdir(join(dir, 'skills'), { withFileTypes: true }).catch(() => [])
  for (const d of skills) {
    if (!d.isDirectory() && !d.isSymbolicLink()) continue
    const path = join(dir, 'skills', d.name, 'SKILL.md')
    const meta = await frontmatter(path)
    if (meta) out.push({ name: meta.name || d.name, description: meta.description, source, path })
  }
  const commands = await readdir(join(dir, 'commands'), { recursive: true }).catch(() => [])
  for (const rel of commands) {
    if (!rel.endsWith('.md')) continue
    const path = join(dir, 'commands', rel)
    const meta = await frontmatter(path)
    if (meta) out.push({ name: rel.slice(0, -3).split('/').join(':'), description: meta.description, source, path })
  }
  return out
}

/** A skill file's name and description, read from its frontmatter's one-line fields. Undefined when it can't be read. */
async function frontmatter(path: string): Promise<{ name?: string; description: string } | undefined> {
  const text = await readFile(path, 'utf8').catch(() => undefined)
  if (text === undefined) return
  const head = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? ''
  const field = (key: string) =>
    new RegExp(`^${key}:[ \\t]*(.*)$`, 'm')
      .exec(head)?.[1]
      .trim()
      .replace(/^(["'])(.*)\1$/, '$2')
  return { name: field('name') || undefined, description: field('description') ?? '' }
}

/** Never offered, however they're ignored or not. */
const SKIPPED_DIRS = new Set(['.git', 'node_modules'])
/** Enough for any repo worth typing paths in; past this, a walk outside git stops. */
const MAX_FILES = 50_000

/** The folders, ending in `/`, and files under `cwd`, relative to it, worked out once for every lookup while it's fresh. */
const projectPaths = cached(async (cwd: string): Promise<string[]> => {
  const files = await projectFiles(cwd)
  const dirs = new Set<string>()
  for (const f of files) for (let i = f.indexOf('/'); i >= 0; i = f.indexOf('/', i + 1)) dirs.add(f.slice(0, i + 1))
  return [...dirs, ...files]
})

/** The files under `cwd`, relative to it: git's tracked and untracked-but-not-ignored ones, or a walk outside a repo. */
async function projectFiles(cwd: string, limit = MAX_FILES): Promise<string[]> {
  const git = await run('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd, maxBuffer: 64 << 20 }).catch(() => undefined)
  // Each once: a file with a merge conflict is listed once per side.
  if (git) return [...new Set(git.stdout.split('\0').filter(Boolean))].slice(0, limit)
  const files: string[] = []
  const walk = async (dir: string) => {
    for (const d of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (files.length >= limit) return
      if (d.name.startsWith('.') || SKIPPED_DIRS.has(d.name)) continue
      const path = join(dir, d.name)
      if (d.isDirectory()) await walk(path)
      else files.push(relative(cwd, path))
    }
  }
  await walk(cwd)
  return files
}

/** Every file in the checkout `cwd` is in, from its top, for browsing it: read afresh each time, since it's asked for when files change. */
export async function checkoutFiles(cwd: string): Promise<CheckoutFiles> {
  const top = await run('git', ['rev-parse', '--show-toplevel'], { cwd }).then(
    (r) => r.stdout.trim(),
    () => '',
  )
  const root = top || cwd
  const files = await projectFiles(root, MAX_FILES + 1)
  return { root, files: files.slice(0, MAX_FILES), truncated: files.length > MAX_FILES }
}

/** The files and folders under `cwd` best matching what's typed after `@`, best first. Folders end in `/`. */
export async function findFiles(cwd: string, typed: string, limit = 50): Promise<string[]> {
  const q = typed.toLowerCase()
  const scored: [number, string][] = []
  for (const path of await projectPaths(cwd)) {
    const score = matchScore(path, q)
    if (score > 0) scored.push([score, path])
  }
  return scored
    .sort((a, b) => b[0] - a[0] || a[1].length - b[1].length || a[1].localeCompare(b[1]))
    .slice(0, limit)
    .map(([, path]) => path)
}

/**
 * How well a path matches: its name starting with what's typed beats the name containing it, which beats the
 * path containing it, which beats the letters turning up in order. 0 for no match. Nothing typed matches the
 * top level only, so a bare `@` shows what's there.
 */
function matchScore(path: string, q: string): number {
  const lower = path.toLowerCase()
  if (!q) return /\/./.test(path) ? 0 : 1
  // In a folder, as after picking one: what's directly in it first.
  const slash = q.lastIndexOf('/')
  if (slash >= 0) {
    const dir = q.slice(0, slash + 1)
    const rest = lower.slice(dir.length)
    if (lower.startsWith(dir) && rest && !/\/./.test(rest) && rest.startsWith(q.slice(slash + 1))) return 5
  }
  const name = basename(lower.replace(/\/$/, ''))
  if (name.startsWith(q)) return 4
  if (name.includes(q)) return 3
  if (lower.includes(q)) return 2
  let at = 0
  for (const ch of lower) if (ch === q[at]) at++
  return at === q.length ? 1 : 0
}
