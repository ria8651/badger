import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { REVIEW_ATTENTION, type ReviewDiff, type ReviewFile } from '../shared/protocol.ts'
import { refuse, reply } from './children.ts'
import { reviewDiff } from './reviewDiff.ts'

export const REVIEW_DIFF_TOOL = 'review_diff'
export const REVIEW_GROUP_TOOL = 'review_guide_group'
export const REVIEW_DONE_TOOL = 'review_guide_done'

/**
 * As much of the diff as one call returns, in characters: under what Claude Code takes from a tool before it saves the
 * output to a file instead (25k tokens), which Claude then has to read back in pieces.
 */
const PAGE_CHARS = 60_000

/**
 * What a review chat is told at the start. The rest of how to guide is in the tools' descriptions,
 * which stay in context however long the chat goes on.
 */
export function reviewPrompt(asked: string[]): string {
  return [
    'Guide me through reviewing the changes in this checkout that aren’t on its base yet, uncommitted ones included.',
    '',
    `I'll read every hunk myself, so don't review them for me or hunt for bugs: make them quick to understand. Call ${REVIEW_DIFF_TOOL}, read whatever else you need to understand the changes, then show the guide a group at a time with ${REVIEW_GROUP_TOOL}, in reading order, and finish with ${REVIEW_DONE_TOOL}. After that I may ask about parts of the diff, or send comments for you to act on.`,
    ...(asked.length
      ? ['', 'For what the changes are for, this is what the chat that made them was asked:', '', ...asked.map((a) => a.replace(/^/gm, '> ')).flatMap((a) => [a, ''])]
      : []),
  ].join('\n')
}

/** Every hunk id in a diff. */
const hunkIds = (files: ReviewFile[]) => files.flatMap((f) => f.hunks.map((h) => h.id))

const describe = (f: ReviewFile) =>
  [f.status, f.oldPath && `from ${f.oldPath}`, f.binary && 'binary', f.truncated && 'too big to show', f.generated && 'generated', `+${f.added} −${f.removed}`]
    .filter(Boolean)
    .join(', ')

/** A file's hunks as Claude reads them, each after its id; a generated file's only by id unless asked for. */
function renderFile(f: ReviewFile, only?: Set<string>, full = false): string {
  const hunks = f.hunks.filter((h) => !only || only.has(h.id))
  const lines = [`## ${f.path} (${describe(f)})`]
  if (f.generated && !full) lines.push(`Generated, so not shown: ${hunks.map((h) => h.id).join(', ')}. Ask for it by file to read it.`)
  else for (const h of hunks) lines.push(`[${h.id}]${h.patch ? `\n${h.patch}` : ' (no lines to show; read the file if you need to)'}`)
  return lines.join('\n')
}

/** The files packed into pages of at most PAGE_CHARS, in order; a file bigger than that is a page of its own. */
function pages(files: ReviewFile[]): ReviewFile[][] {
  const out: ReviewFile[][] = []
  let size = Infinity
  for (const f of files) {
    const n = renderFile(f).length
    if (size + n > PAGE_CHARS) {
      out.push([])
      size = 0
    }
    out[out.length - 1].push(f)
    size += n
  }
  return out
}

function render(diff: ReviewDiff, args: { hunks?: string[]; files?: string[]; page?: number }): string {
  const head = `Branch ${diff.branch || '(detached)'}${diff.base ? `, against ${diff.base}` : ''}. ${hunkIds(diff.files).length} hunks in ${diff.files.length} files.`
  if (args.hunks?.length || args.files?.length) {
    const hunks = args.hunks?.length ? new Set(args.hunks) : undefined
    const files = args.files?.length ? new Set(args.files) : undefined
    const shown = diff.files.filter((f) => (!files || files.has(f.path)) && (!hunks || f.hunks.some((h) => hunks.has(h.id))))
    const text = [head, ...shown.map((f) => renderFile(f, hunks, !!files))].join('\n\n')
    return text.length > PAGE_CHARS ? `${text.slice(0, PAGE_CHARS)}\n\n… cut off here: ask for fewer files or hunks.` : text
  }
  const all = pages(diff.files)
  if (all.length <= 1 && args.page === undefined) return [head, ...diff.files.map((f) => renderFile(f))].join('\n\n')
  if (args.page !== undefined) {
    const page = all[args.page - 1]
    if (!page) return `There are ${all.length} pages.`
    return [`${head} Page ${args.page} of ${all.length}.`, ...page.map((f) => renderFile(f))].join('\n\n')
  }
  // Too big for one reply: what's in it, and how to read it a page at a time.
  return [
    `${head} That's too much for one reply, so here's what's in it. Read it with page: 1 to ${all.length}, or by files or hunks.`,
    ...all.map((page, i) => [`### Page ${i + 1}`, ...page.map((f) => `- ${f.path} (${describe(f)}): ${f.hunks.map((h) => h.id).join(', ')}`)].join('\n')),
  ].join('\n\n')
}

/** Which hunks each group of a chat's guide has, in the guide's order, kept between calls and restarts. */
type Placed = { order: string[]; groups: Record<string, string[]> }

function store(dir: string, sessionId: string) {
  const file = join(dir, `${sessionId}.json`)
  return {
    read: async (): Promise<Placed> => JSON.parse(await readFile(file, 'utf8').catch(() => '{"order":[],"groups":{}}')),
    write: async (p: Placed) => {
      await mkdir(dir, { recursive: true })
      await writeFile(file, JSON.stringify(p))
    },
  }
}

/** How far the guide has got against the diff now: hunks placed, and the ones still to go. */
function progress(p: Placed, diff: ReviewDiff): { placed: number; missing: string[] } {
  const inGuide = new Set(p.order.flatMap((g) => p.groups[g] ?? []))
  const all = hunkIds(diff.files)
  const missing = all.filter((h) => !inGuide.has(h))
  return { placed: all.length - missing.length, missing }
}

const list = (ids: string[], max = 40) => (ids.length > max ? `${ids.slice(0, max).join(', ')} and ${ids.length - max} more` : ids.join(', '))

/** The tools only a review chat has: the diff with hunk ids, and showing its guide beside it a group at a time. */
export function reviewGuideTools(sessionId: string, cwd: () => string, dir: string) {
  const saved = store(dir, sessionId)
  const current = () => reviewDiff(cwd(), { kind: 'base' })
  return [
    tool(
      REVIEW_DIFF_TOOL,
      [
        'The changes under review: everything in this checkout not on its base yet (the main checkout’s branch in a worktree, else the upstream), uncommitted and untracked files included. 3 lines of context.',
        'Each hunk starts with its id in brackets, e.g. [h3f2a91c0]; the guide refers to hunks by these. An id stays the same while its lines do, wherever they move in the file.',
        'A small diff comes whole. A big one comes as a list of its files and their hunk ids, to read by page, or by files or hunks. Generated files (lockfiles and the like) are listed by hunk id; ask for them by file to read them.',
      ].join(' '),
      {
        page: z.number().int().min(1).optional().describe('Which page of a big diff'),
        files: z.array(z.string()).optional().describe('Only these paths, relative to the checkout'),
        hunks: z.array(z.string()).optional().describe('Only these hunk ids'),
      },
      async (args) => {
        try {
          return reply(render(await current(), args))
        } catch (err) {
          return refuse((err as Error).message)
        }
      },
      { annotations: { readOnlyHint: true } },
    ),
    tool(
      REVIEW_GROUP_TOOL,
      [
        'Show one group of your guide to the changes; it appears beside the diff straight away. The user reads every hunk themselves: the guide decides the order they read them in and explains each part, so it’s quick to understand. Call it once per group, in reading order, then call review_guide_done.',
        '',
        '- A group is hunks that are one change, across files: a field added to a struct and threaded through 20 files is one group, and so is a rename. A single hunk can be a group. Every hunk ends up in exactly one group.',
        '- attention is how carefully a person should read it. high: new or changed logic where a mistake would matter. medium: ordinary changes worth reading properly. low: mechanical changes to skim (renames, passing a value through, moved code, formatting, generated files).',
        '- Go from high to low attention and, within that, so earlier groups introduce what later ones use.',
        '- explanation is for someone who hasn’t seen the chat that made the changes. For low attention, a sentence ("Renames fooId to cardId and passes it through"). For high, a few short paragraphs in plain language: the background needed, what happened before, what happens now and how, and what to check. Define terms the first time; don’t assume shared context.',
        '',
        'Calling it again with a group’s id changes that group: leave out title, attention, kind or explanation to keep them, and pass hunks to replace its hunks. A hunk given to one group leaves any other it was in. After the changes move on (e.g. you acted on comments), update the groups that changed this way, then call review_guide_done again.',
      ].join('\n'),
      {
        id: z.string().describe('A short slug, e.g. "settings-field".'),
        title: z.string().optional().describe('What the change is, in a few words. Needed for a new group.'),
        attention: z.enum(REVIEW_ATTENTION).optional().describe('Needed for a new group.'),
        kind: z.string().optional().describe('A word or two, e.g. "new logic", "rename", "plumbing", "tests", "config".'),
        explanation: z.string().optional().describe('Markdown. Needed for a new group.'),
        hunks: z.array(z.string()).optional().describe('Hunk ids from review_diff, e.g. "h3f2a91c0". Needed for a new group.'),
      },
      async (g) => {
        let diff: ReviewDiff
        try {
          diff = await current()
        } catch (err) {
          return refuse((err as Error).message)
        }
        const p = await saved.read()
        const fresh = !p.groups[g.id]
        if (fresh) {
          const needs = (['title', 'attention', 'explanation', 'hunks'] as const).filter((k) => !g[k]?.length)
          if (needs.length) return refuse(`Not shown: a new group needs ${needs.join(', ')}.`)
        }
        if (g.hunks) {
          const known = new Set(hunkIds(diff.files))
          const unknown = g.hunks.filter((h) => !known.has(h))
          if (unknown.length) return refuse(`Not shown: these aren't hunks in the diff now (changed, or never were): ${list(unknown)}. Call ${REVIEW_DIFF_TOOL} for the current ones.`)
          if (!g.hunks.length) return refuse('Not shown: a group needs at least one hunk.')
          const moving = new Set(g.hunks)
          for (const id of p.order) if (id !== g.id) p.groups[id] = (p.groups[id] ?? []).filter((h) => !moving.has(h))
          p.groups[g.id] = [...new Set(g.hunks)]
        }
        if (fresh) p.order.push(g.id)
        await saved.write(p)
        const { placed, missing } = progress(p, diff)
        return reply(
          `Shown "${g.id}". ${placed} of ${placed + missing.length} hunks are in the guide${missing.length ? `; these aren't yet: ${list(missing)}.` : `. Call ${REVIEW_DONE_TOOL} to finish.`}`,
        )
      },
    ),
    tool(
      REVIEW_DONE_TOOL,
      `Finish the guide once every hunk is in a group: refused, with what's left, until then. Call it again after updating groups.`,
      {
        summary: z.string().optional().describe('What the changes do as a whole, in two to four sentences of Markdown. Leave it out to keep the last one.'),
        order: z.array(z.string()).optional().describe('Group ids in reading order, if it should change. Any left out stay after these, in the order they were.'),
        remove: z.array(z.string()).optional().describe('Groups to drop, e.g. ones whose hunks have all gone elsewhere'),
      },
      async ({ order, remove }) => {
        let diff: ReviewDiff
        try {
          diff = await current()
        } catch (err) {
          return refuse((err as Error).message)
        }
        const p = await saved.read()
        const unknown = [...(order ?? []), ...(remove ?? [])].filter((id) => !p.groups[id])
        if (unknown.length) return refuse(`Not done: there are no groups ${list(unknown)}.`)
        const next: Placed = {
          order: [...new Set([...(order ?? []), ...p.order])].filter((id) => !remove?.includes(id)),
          groups: Object.fromEntries(Object.entries(p.groups).filter(([id]) => !remove?.includes(id))),
        }
        const { placed, missing } = progress(next, diff)
        if (missing.length) return refuse(`Not done: ${missing.length} of ${placed + missing.length} hunks aren't in a group yet: ${list(missing)}.`)
        await saved.write(next)
        return reply(`Done: ${next.order.length} groups covering all ${placed} hunks.`)
      },
    ),
  ]
}
