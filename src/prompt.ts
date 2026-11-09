/**
 * Chips in a prompt: files mentioned as `@path` (`@"a path"` when it has spaces), and slash commands and skills as
 * `/name`. A prompt is still plain text, which is what's saved and sent; chips are how it's shown.
 */

export type Chip = { kind: 'file'; value: string } | { kind: 'command'; value: string }

export type Segment = string | Chip

/** How a chip is written in the text. */
export function chipText(chip: Chip): string {
  if (chip.kind === 'command') return `/${chip.value}`
  return /\s/.test(chip.value) ? `@"${chip.value}"` : `@${chip.value}`
}

/** A command at the very start: Claude Code only runs one there. A path like `/etc/hosts` isn't one. */
export const COMMAND = /^\/([\w][\w:.-]*)(?=\s|$)/
/**
 * A mention, or a skill past the start, starts the text or follows a space, so an email address or `and/or` isn't
 * one. Claude Code doesn't run a skill there; Claude reads it and calls the skill itself.
 */
const MENTION = /(^|\s)(?:@(?:"([^"\n]+)"|([^\s"]+))|\/(\w[\w:.-]*)(?![^\s,;!?)\]}'"]))/g

/**
 * The text as plain runs and chips. Only mentions that look like paths, with a `/` or a `.`, are chips, so
 * `@someone` or a Java `@Override` pasted in stays text, unless `file` knows it is one, like a picked `Makefile`.
 * A `/name` past the start is one only if `skill` knows it, so `/tmp` stays a path.
 * `glued`: the text carries straight on from something before it, e.g. code, so an `@` or `/` it starts with is neither.
 */
export function segments(text: string, opts: ChipOptions = {}): Segment[] {
  const out: Segment[] = []
  let at = 0
  for (const { chip, from, to } of chipsIn(text, opts)) {
    if (from > at) out.push(text.slice(at, from))
    out.push(chip)
    at = to
  }
  if (at < text.length) out.push(text.slice(at))
  return out
}

type ChipOptions = {
  /** The text starts the prompt, so a command can start it; given a function, only one it knows. */
  command?: boolean | ((name: string) => boolean)
  file?: (path: string) => boolean
  skill?: (name: string) => boolean
  glued?: boolean
}

/** The chips in the text, as `segments` finds them, with where each one's written. */
export function chipsIn(text: string, opts: ChipOptions = {}): { chip: Chip; from: number; to: number }[] {
  const out: { chip: Chip; from: number; to: number }[] = []
  const command = opts.command ? COMMAND.exec(text) : null
  let offset = 0
  if (command && (typeof opts.command !== 'function' || opts.command(command[1]))) {
    out.push({ chip: { kind: 'command', value: command[1] }, from: 0, to: command[0].length })
    offset = command[0].length
  }
  for (const m of text.slice(offset).matchAll(MENTION)) {
    if (opts.glued && m.index === 0 && !m[1]) continue
    const start = offset + m.index + m[1].length
    if (m[4] !== undefined) {
      // At the start Claude Code takes the whole word as the command's name, punctuation and all, so it's not one.
      if (opts.command && start === 0) continue
      // Trailing punctuation is the sentence's.
      const name = m[4].replace(/[.:-]+$/, '')
      if (opts.skill?.(name)) out.push({ chip: { kind: 'command', value: name }, from: start, to: start + 1 + name.length })
      continue
    }
    const path = m[2] ?? m[3]
    // Trailing punctuation is the sentence's, not the path's, unless it's a folder's slash.
    const trimmed = m[2] ? path : path.replace(/[,;:!?)\]}'.]+$/, '')
    if (!(/[/.]/.test(trimmed) || opts.file?.(trimmed)) || trimmed === '.' || trimmed === '..') continue
    out.push({ chip: { kind: 'file', value: trimmed }, from: start, to: start + 1 + (m[2] ? path.length + 2 : trimmed.length) })
  }
  return out
}

/**
 * Code and links in a prompt, as Claude reads them: a fenced block, from its opening fence line to its closing one,
 * `inline code`, and web addresses outside both. They're only how the text is shown; it's sent as typed.
 */
export type Span =
  | { kind: 'code'; from: number; to: number }
  | { kind: 'url'; from: number; to: number }
  /** `code` is where the code inside the fences is, `lang` what its opening fence says it's in, and `closed` whether it's closed. */
  | { kind: 'fence'; from: number; to: number; code: { from: number; to: number }; lang?: string; closed: boolean }

/** A backtick fence's line has no other backtick, or ```x``` starting a line would be one rather than inline code. */
const FENCE = /^ {0,3}(?:(`{3,})(?=[^`]*$)|(~{3,}))\s*(\S*)/
/** Not after a backtick or a backslash, which would make it part of a longer run, or escaped. */
const INLINE_CODE = /(?<![`\\])(`+)(?!`)[^\n]*?[^`\n]\1(?!`)/g
/** `￼` is a chip in the composer, which ends one. */
const WEB_URL = /\bhttps?:\/\/[^\s<>"'`￼]+/g

/** Where each span is in the text, in order; none overlap. */
export function spans(text: string): Span[] {
  const out: Span[] = []
  let fence: { mark: string; lang: string; from: number; code: number } | undefined
  let at = 0
  for (const line of text.split('\n')) {
    const end = at + line.length
    const open = FENCE.exec(line)
    const mark = open?.[1] ?? open?.[2]
    if (fence) {
      // Closed by a fence of the same character, at least as long, with nothing after it.
      if (mark && mark[0] === fence.mark[0] && mark.length >= fence.mark.length && !line.trim().slice(mark.length).trim()) {
        const code = { from: fence.code, to: Math.max(fence.code, at - 1) }
        out.push({ kind: 'fence', from: fence.from, to: end, code, lang: fence.lang.toLowerCase() || undefined, closed: true })
        fence = undefined
      }
    } else if (mark) fence = { mark, lang: open![3], from: at, code: end + 1 }
    else inlineSpans(line, at, out)
    at = end + 1
  }
  // One left open runs to the end, as it does in Markdown.
  if (fence) {
    const code = { from: Math.min(fence.code, text.length), to: text.length }
    out.push({ kind: 'fence', from: fence.from, to: text.length, code, lang: fence.lang.toLowerCase() || undefined, closed: false })
  }
  return out
}

function inlineSpans(line: string, offset: number, out: Span[]) {
  let at = 0
  const urls = (to: number) => {
    for (const m of line.slice(at, to).matchAll(WEB_URL)) {
      const url = trimUrl(m[0])
      // Nothing left after the scheme: not an address.
      if (url.endsWith('://')) continue
      const from = offset + at + m.index
      out.push({ kind: 'url', from, to: from + url.length })
    }
  }
  for (const m of line.matchAll(INLINE_CODE)) {
    urls(m.index)
    out.push({ kind: 'code', from: offset + m.index, to: offset + m.index + m[0].length })
    at = m.index + m[0].length
  }
  urls(line.length)
}

/** Trailing punctuation is the sentence's, and a closing bracket only the address's if it opened one too. */
function trimUrl(url: string): string {
  for (;;) {
    const last = url.at(-1)!
    const open = ({ ')': '(', ']': '[', '}': '{' } as Record<string, string>)[last]
    if (/[.,;:!?*_]/.test(last)) url = url.slice(0, -1)
    else if (open && url.split(open).length < url.split(last).length) url = url.slice(0, -1)
    else return url
  }
}
