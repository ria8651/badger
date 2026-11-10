import type { DraftComment } from './protocol.ts'

/*
 * Comments on what Claude wrote, kept with a chat's draft and sent together, as comments on a diff are: on its replies,
 * a plan, the changes, or a file. They go in the message they're sent with, ahead of what's typed, each tagged with what
 * it's on as it was when it was written, so the transcript can show them as chips (splitComments) and Claude reads them
 * whole. What Claude's asked to do with them is tagged too, and isn't shown.
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

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max).trimEnd()}…` : text)

/** What a comment's on, in a few words, e.g. for its chip. */
export function commentLabel(c: Pick<DraftComment, 'on' | 'quote'>): string {
  const on = c.on
  const words = `“${clip(c.quote.replace(/\s+/g, ' ').trim(), 40)}”`
  switch (on.kind) {
    case 'reply':
      return words
    case 'plan':
      return `Plan: ${words}`
    case 'diff':
      return `${on.path.split('/').pop()}, ${on.where}`
    case 'file':
      return `${on.path.split('/').pop()}:${on.from === on.to ? on.from : `${on.from}–${on.to}`}`
  }
}

/** Where a comment's on, as Claude's told it: a file's path and lines, or what of Claude's it was. */
function where(c: Pick<DraftComment, 'on'>): string {
  const on = c.on
  switch (on.kind) {
    case 'reply':
      return 'your reply'
    case 'plan':
      return 'your plan'
    case 'diff':
      return `${on.path}, ${on.where} of the changes`
    case 'file':
      return `${on.path}, ${on.from === on.to ? `line ${on.from}` : `lines ${on.from}–${on.to}`}`
  }
}

const attr = (s: string) => s.replace(/["\n]/g, ' ')
/** A comment, tagged: what it's on, its quote of that, and what was said, which a question has none of here. */
const tagged = (c: Pick<DraftComment, 'on' | 'quote' | 'text'>) => {
  const quote = c.on.kind === 'reply' || c.on.kind === 'plan' ? clip(c.quote.trim(), QUOTE_MAX) : c.quote
  return `<comment kind="${c.on.kind}" on="${attr(where(c))}" label="${attr(commentLabel(c))}">\n<quote>\n${quote}\n</quote>\n${c.text.trim()}\n</comment>`
}
/** What Claude's asked to do with the comments, which isn't shown. */
const ask = (lead: string) => `<comments>${lead}</comments>`

/** A question about what a comment would be on, asked in a side chat rather than kept to send. */
export const questionMessage = (c: Omit<DraftComment, 'id'>) =>
  // The question first, which the side chat's named for.
  [c.text.trim(), ask("A question about what's quoted below. Just answer; don't change anything for this."), tagged({ ...c, text: '' })].join('\n\n')

/** Said after the comments' lead in a guided review, which is kept up to date with what changes. */
export const GUIDE_AFTER_COMMENTS = 'Then update the guide for what changed (review_guide_group, then review_guide_done).'

/**
 * The message comments go to Claude in: what to do with them, each with what it's on, then what else was typed. `plain`:
 * untagged, quoted as Markdown, for where it isn't shown as a message, e.g. sending a plan back.
 */
export function commentsMessage(comments: DraftComment[], note: string, opts: { guided?: boolean; lead?: string; plain?: boolean } = {}): string {
  if (!comments.length) return note
  const n = comments.length
  const lead = [
    opts.lead ??
      (n === 1 ? 'I left a comment. Answer or act on it, and say if you disagree.' : `I left ${n} comments. Answer or act on each, and say if you disagree with any.`),
    opts.guided && comments.some((c) => c.on.kind === 'diff') ? GUIDE_AFTER_COMMENTS : '',
  ]
    .filter(Boolean)
    .join(' ')
  const each = opts.plain ? comments.map((c) => `On ${where(c)}:\n${blockquote(c.quote, QUOTE_MAX)}\n\n${c.text.trim()}`) : comments.map(tagged)
  return [opts.plain ? lead : ask(lead), ...each, note.trim()].filter(Boolean).join('\n\n')
}

/** A comment as it went, for the transcript to show. */
export type SentComment = { kind: DraftComment['on']['kind']; label: string; quote: string; text: string }

const COMMENT = /<comment kind="(\w+)" on="[^"]*" label="([^"]*)">\n<quote>\n([\s\S]*?)\n<\/quote>\n([\s\S]*?)<\/comment>\s*/g
const LEAD = /<comments>[\s\S]*?<\/comments>\s*/g

/** A message's text without the comments tagged in it, and the comments. */
export function splitComments(text: string): { text: string; comments: SentComment[] } {
  if (!text.includes('<comment')) return { text, comments: [] }
  const comments: SentComment[] = []
  const rest = text
    .replace(COMMENT, (_, kind: SentComment['kind'], label: string, quote: string, said: string) => {
      comments.push({ kind, label, quote, text: said.trim() })
      return ''
    })
    .replace(LEAD, '')
  return { text: rest.trim(), comments }
}
