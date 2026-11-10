import type { DraftComment } from './protocol.ts'

/*
 * Comments on what Claude wrote, kept with a chat's draft and sent together, as comments on a diff are: on its replies,
 * a plan, the changes, or a file. They go in the message they're sent with, ahead of what's typed, each under what
 * it's on as it was when it was written.
 */

const QUOTE_MAX = 600

/** Text as a Markdown quote, cut to `max` characters, with runs of blank lines made one. */
export const blockquote = (text: string, max = Infinity) => {
  const t = text.trim().replace(/\n{3,}/g, '\n\n')
  return (t.length > max ? `${t.slice(0, max).trimEnd()}…` : t)
    .split('\n')
    .map((line) => (line.trim() ? `> ${line}` : '>'))
    .join('\n')
}

/** What a comment's on, as Claude's told it. */
function quoted(c: DraftComment): string {
  const on = c.on
  switch (on.kind) {
    case 'reply':
      return blockquote(c.quote, QUOTE_MAX)
    case 'plan':
      return `On the plan:\n${blockquote(c.quote, QUOTE_MAX)}`
    case 'diff':
      return `${on.path}, ${on.where}:\n\`\`\`diff\n${c.quote}\n\`\`\``
    case 'file':
      return `${on.path}, ${on.from === on.to ? `line ${on.from}` : `lines ${on.from}–${on.to}`}:\n\`\`\`\n${c.quote}\n\`\`\``
  }
}

/** Said after the comments' lead in a guided review, which is kept up to date with what changes. */
export const GUIDE_AFTER_COMMENTS = 'Then update the guide for what changed (review_guide_group, then review_guide_done).'

/** The message comments go to Claude in: what to do with them, each under what it's on, then what else was typed. */
export function commentsMessage(comments: DraftComment[], note: string, opts: { guided?: boolean; lead?: string } = {}): string {
  if (!comments.length) return note
  const n = comments.length
  const lead = [
    opts.lead ??
      (n === 1 ? 'I left a comment. Answer or act on it, and say if you disagree.' : `I left ${n} comments. Answer or act on each, and say if you disagree with any.`),
    opts.guided && comments.some((c) => c.on.kind === 'diff') ? GUIDE_AFTER_COMMENTS : '',
  ]
    .filter(Boolean)
    .join(' ')
  return [lead, ...comments.map((c) => `${quoted(c)}\n\n${c.text.trim()}`), note.trim()].filter(Boolean).join('\n\n')
}
