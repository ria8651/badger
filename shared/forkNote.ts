/** Where a forked chat ran and where it runs now, each as a folder and the runner it's on. */
export interface Move {
  from: Place
  to: Place
}

export interface Place {
  machine: string
  cwd: string
  /** In a new git worktree of `cwd`, made when the chat next runs. */
  worktree?: boolean
}

const PREFIX = 'This chat was forked from one that ran in '

const place = (p: Place) => `${p.worktree ? 'a new git worktree of ' : ''}${p.cwd} on ${p.machine}`

/**
 * What a fork is told on its first turn when it runs somewhere other than the
 * chat it came from, so Claude doesn't trust paths from before. One paragraph:
 * the turn's context joins it to the card's after a blank line.
 */
export function renderMoveNote(m: Move): string {
  return `${PREFIX}${place(m.from)}. It now runs in ${place(m.to)}. Paths earlier in this conversation point at the old place, and no files were copied over, so check they're here before relying on them.`
}

/** What a side chat (/btw) is told on its first turn. One paragraph, like a move note. */
export const SIDE_NOTE =
  "This is a side chat: a copy of the conversation so far, opened beside it to ask something on the side. The main chat may still be running in the same folder, so its files can change under you. Answer what's asked here; the main chat won't see this one."

/** A turn's context, split into the side chat note at its start, if any, and the rest. */
export function splitSideNote(text: string): { side: boolean; rest: string } {
  if (!text.startsWith(SIDE_NOTE)) return { side: false, rest: text }
  return { side: true, rest: text.slice(SIDE_NOTE.length).replace(/^\n\n/, '') }
}

const NOTE = /^This chat was forked from one that ran in (a new git worktree of )?(.+) on (.+?)\. It now runs in (a new git worktree of )?(.+) on (.+?)\. Paths earlier in this conversation .*$/

/** A turn's context, split into the move note at its start, if any, and the rest. */
export function splitMoveNote(text: string): { move?: Move; rest: string } {
  if (!text.startsWith(PREFIX)) return { rest: text }
  const end = text.indexOf('\n\n')
  const note = end < 0 ? text : text.slice(0, end)
  const m = note.match(NOTE)
  if (!m) return { rest: text }
  return {
    move: { from: { machine: m[3], cwd: m[2], worktree: !!m[1] || undefined }, to: { machine: m[6], cwd: m[5], worktree: !!m[4] || undefined } },
    rest: end < 0 ? '' : text.slice(end + 2),
  }
}
