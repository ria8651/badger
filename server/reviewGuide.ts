import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { REVIEW_ATTENTION, type ReviewDiff, type ReviewFile } from '../shared/protocol.ts'
import { refuse, reply } from './children.ts'
import { clip } from './ops.ts'
import { reviewDiff } from './reviewDiff.ts'

export const REVIEW_DIFF_TOOL = 'review_diff'
export const REVIEW_GUIDE_TOOL = 'report_review_guide'

/** As much of the diff as one call returns; past that Claude is told to ask for less. */
const DIFF_CHARS = 120_000

/**
 * What a review chat is told at the start. The rest of how to guide is in the tools' descriptions,
 * which stay in context however long the chat goes on.
 */
export function reviewPrompt(asked: string[]): string {
  return [
    'Guide me through reviewing the changes in this checkout that aren’t on its base yet, uncommitted ones included.',
    '',
    `I'll read every hunk myself, so don't review them for me or hunt for bugs: make them quick to understand. Call ${REVIEW_DIFF_TOOL}, read whatever else you need to understand the changes, then call ${REVIEW_GUIDE_TOOL}. After that I may ask about parts of the diff, or send comments for you to act on.`,
    ...(asked.length
      ? ['', 'For what the changes are for, this is what the chat that made them was asked:', '', ...asked.map((a) => a.replace(/^/gm, '> ')).flatMap((a) => [a, ''])]
      : []),
  ].join('\n')
}

/** Every hunk id in a diff. */
const hunkIds = (files: ReviewFile[]) => files.flatMap((f) => f.hunks.map((h) => h.id))

function render(diff: ReviewDiff, only?: { hunks?: string[]; files?: string[] }): string {
  const hunks = only?.hunks?.length ? new Set(only.hunks) : undefined
  const files = only?.files?.length ? new Set(only.files) : undefined
  const out: string[] = [`Branch ${diff.branch || '(detached)'}${diff.base ? `, against ${diff.base}` : ''}. ${hunkIds(diff.files).length} hunks in ${diff.files.length} files.`]
  for (const f of diff.files) {
    if (files && !files.has(f.path)) continue
    const shown = f.hunks.filter((h) => !hunks || hunks.has(h.id))
    if (!shown.length) continue
    const what = [f.status, f.oldPath && `from ${f.oldPath}`, f.binary && 'binary', f.truncated && 'too big to show', f.generated && 'generated'].filter(Boolean).join(', ')
    out.push('', `## ${f.path} (${what}, +${f.added} −${f.removed})`)
    for (const h of shown) out.push(`[${h.id}]${h.patch ? `\n${h.patch}` : ' (no lines to show; read the file if you need to)'}`)
  }
  return out.join('\n')
}

const group = z.object({
  id: z.string().describe('A short slug, e.g. "settings-field". Reuse it in a later guide for the same group.'),
  title: z.string().optional().describe('What the change is, in a few words.'),
  attention: z.enum(REVIEW_ATTENTION).optional(),
  kind: z.string().optional().describe('A word or two, e.g. "new logic", "rename", "plumbing", "tests", "config".'),
  explanation: z.string().optional().describe('Markdown.'),
  hunks: z.array(z.string()).min(1).describe('Hunk ids from review_diff, e.g. "h3f2a91c0".'),
})

/** The tools only a review chat has: the diff with hunk ids, and showing its guide beside it. */
export function reviewGuideTools(cwd: () => string) {
  return [
    tool(
      REVIEW_DIFF_TOOL,
      [
        'The changes under review: everything in this checkout not on its base yet (the main checkout’s branch in a worktree, else the upstream), uncommitted and untracked files included. 3 lines of context.',
        'Each hunk starts with its id in brackets, e.g. [h3f2a91c0]; the guide refers to hunks by these. An id stays the same while its lines do, wherever they move in the file.',
        'Pass hunks or files to read only some.',
      ].join(' '),
      {
        hunks: z.array(z.string()).optional().describe('Only these hunk ids'),
        files: z.array(z.string()).optional().describe('Only these paths, relative to the checkout'),
      },
      async (args) => {
        try {
          const text = render(await reviewDiff(cwd(), { kind: 'base' }), args)
          return reply(text.length > DIFF_CHARS ? `${clip(text, DIFF_CHARS)}\n\nThat's as much as one call returns: ask for the rest by files or hunks.` : text)
        } catch (err) {
          return refuse((err as Error).message)
        }
      },
      { annotations: { readOnlyHint: true } },
    ),
    tool(
      REVIEW_GUIDE_TOOL,
      [
        'Show the user your guide to the changes. They read every hunk themselves; the guide decides the order they read them in and explains each part, so it’s quick to understand.',
        '',
        '- Group hunks that are one change, across files: a field added to a struct and threaded through 20 files is one group, and so is a rename. A group can be a single hunk. Every hunk from review_diff goes in exactly one group: the call is refused otherwise.',
        '- attention is how carefully a person should read it. high: new or changed logic where a mistake would matter. medium: ordinary changes worth reading properly. low: mechanical changes to skim (renames, passing a value through, moved code, formatting, generated files).',
        '- Order groups from high to low attention and, within that, so earlier groups introduce what later ones use.',
        '- explanation is for someone who hasn’t seen the chat that made the changes. For low attention, a sentence ("Renames fooId to cardId and passes it through"). For high, a few short paragraphs in plain language: the background needed, what happened before, what happens now and how, and what to check. Define terms the first time; don’t assume shared context.',
        '- summary: what the changes do as a whole, in two to four sentences.',
        '',
        'After the changes move on (e.g. you acted on comments), call it again with every current hunk. A group whose id was in your last guide can leave out title, attention, kind and explanation to keep them.',
      ].join('\n'),
      {
        summary: z.string().optional().describe('Markdown. Leave it out to keep the last one.'),
        groups: z.array(group),
      },
      async ({ groups }) => {
        let diff: ReviewDiff
        try {
          diff = await reviewDiff(cwd(), { kind: 'base' })
        } catch (err) {
          return refuse((err as Error).message)
        }
        const current = new Set(hunkIds(diff.files))
        const placed = new Map<string, string>()
        const unknown: string[] = []
        const twice: string[] = []
        for (const g of groups) {
          for (const h of g.hunks) {
            if (!current.has(h)) unknown.push(h)
            else if (placed.has(h)) twice.push(`${h} (${placed.get(h)} and ${g.id})`)
            else placed.set(h, g.id)
          }
        }
        const missing = [...current].filter((h) => !placed.has(h))
        const ids = groups.map((g) => g.id)
        const dupes = ids.filter((id, i) => ids.indexOf(id) !== i)
        const problems = [
          missing.length && `These hunks aren't in any group: ${missing.join(', ')}.`,
          unknown.length && `These aren't hunks in the diff now (changed, or never were): ${unknown.join(', ')}. Call ${REVIEW_DIFF_TOOL} for the current ones.`,
          twice.length && `These are in more than one group: ${twice.join(', ')}.`,
          dupes.length && `These group ids are used more than once: ${[...new Set(dupes)].join(', ')}.`,
        ].filter(Boolean)
        if (problems.length) return refuse(`Not shown. ${problems.join(' ')}`)
        return reply(`Shown: ${groups.length} groups covering all ${current.size} hunks.`)
      },
    ),
  ]
}
