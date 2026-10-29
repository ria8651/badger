import type { ReviewHunk } from '../shared/protocol.ts'

/**
 * A diff's hunks as rows: their @@ lines, and each line with its number before and after and what in it changed.
 * The diff draws them; a file shown whole marks its lines from them.
 */

export type Line = { kind: 'ctx' | 'add' | 'del'; old?: number; new?: number; text: string; /** The characters that changed, from..to: against its pair, or all of it. */ marks?: [number, number][] }
export type Row = { kind: 'hunk'; text: string } | Line

export const anchorOf = (r: Line) => (r.kind === 'del' ? `o${r.old}` : `n${r.new}`)
export const SIGN = { ctx: ' ', add: '+', del: '-' } as const

/** A hunk's rows, worked out once per hunk: hunks keep their identity while their lines don't change. */
const rowCache = new WeakMap<ReviewHunk, Row[]>()
export function rowsFor(hunk: ReviewHunk): Row[] {
  let rows = rowCache.get(hunk)
  if (!rows) rowCache.set(hunk, (rows = rowsOf(hunk.patch)))
  return rows
}

function rowsOf(patch: string): Row[] {
  const rows: Row[] = []
  let o = 0
  let n = 0
  for (const l of patch.split('\n')) {
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/.exec(l)
    if (h) {
      o = Number(h[1])
      n = Number(h[2])
      rows.push({ kind: 'hunk', text: h[3] })
    } else if (l.startsWith('+')) rows.push({ kind: 'add', new: n++, text: l.slice(1) })
    else if (l.startsWith('-')) rows.push({ kind: 'del', old: o++, text: l.slice(1) })
    else if (l.startsWith(' ')) rows.push({ kind: 'ctx', old: o++, new: n++, text: l.slice(1) })
  }
  markChanges(rows)
  return rows
}

/** Words, runs of spaces, and each other character: what a line's changes are found in. */
const TOKEN = /\w+|\s+|[^\w\s]/g
/** Past this many token pairs, or a line this long, comparing two lines isn't worth it: they're marked whole. */
const MAX_COMPARE = 250_000
const MAX_LINE = 2000

/** All of a line but its indentation and trailing spaces, or nothing for a blank one. */
const whole = (text: string): [number, number][] => {
  const from = text.length - text.trimStart().length
  const to = text.trimEnd().length
  return from < to ? [[from, to]] : []
}

/**
 * What changed between a removed line and the added one it became, as ranges of each: the tokens that aren't in their
 * longest common subsequence, with ranges only spaces apart joined. Undefined when they have too little in common to be
 * one line edited, rather than one line swapped for another.
 */
function lineDiff(a: string, b: string): { a: [number, number][]; b: [number, number][] } | undefined {
  if (a.length > MAX_LINE || b.length > MAX_LINE) return
  const x = a.match(TOKEN) ?? []
  const y = b.match(TOKEN) ?? []
  if (!x.length || !y.length || x.length * y.length > MAX_COMPARE) return
  // lcs[i][j]: the longest common subsequence of x from i and y from j.
  const lcs = Array.from({ length: x.length + 1 }, () => new Uint16Array(y.length + 1))
  for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) lcs[i][j] = x[i] === y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
  const keepX = new Array<boolean>(x.length).fill(false)
  const keepY = new Array<boolean>(y.length).fill(false)
  let same = 0
  for (let i = 0, j = 0; i < x.length && j < y.length; ) {
    if (x[i] === y[j]) {
      keepX[i] = keepY[j] = true
      if (x[i].trim()) same += x[i].length
      i++
      j++
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) i++
    else j++
  }
  const longest = Math.max(a.replace(/\s/g, '').length, b.replace(/\s/g, '').length)
  if (same < longest * 0.3) return
  const ranges = (tokens: string[], keep: boolean[]) => {
    const out: [number, number][] = []
    let at = 0
    // Whether everything kept since the last change was spaces, so the two join.
    let onlySpaces = true
    tokens.forEach((t, i) => {
      const end = at + t.length
      if (!keep[i]) {
        const last = out.at(-1)
        // Joined across spaces kept between them: "foo bar" to "baz qux" is one change, not two.
        if (last && onlySpaces) last[1] = end
        else out.push([at, end])
        onlySpaces = true
      } else if (t.trim()) onlySpaces = false
      at = end
    })
    return out.filter(([f, t]) => t > f)
  }
  return { a: ranges(x, keepX), b: ranges(y, keepY) }
}

/**
 * Every changed character, so the strong colour always means changed and the row's tint alone means part of a change.
 * In a run of removed lines then added ones, each pair in order is compared, if they're alike enough to be a line edited;
 * any other line, removed or added, changed whole.
 */
function markChanges(rows: Row[]) {
  for (let i = 0; i < rows.length; ) {
    let d = i
    while (d < rows.length && rows[d].kind === 'del') d++
    let a = d
    while (a < rows.length && rows[a].kind === 'add') a++
    const removed = rows.slice(i, d) as Line[]
    const added = rows.slice(d, a) as Line[]
    removed.forEach((x, k) => {
      const y = added[k]
      const diff = y && lineDiff(x.text, y.text)
      x.marks = diff ? diff.a : whole(x.text)
      if (y) y.marks = diff ? diff.b : whole(y.text)
    })
    for (const y of added.slice(removed.length)) y.marks = whole(y.text)
    i = Math.max(a, i + 1)
  }
}

/** A hunk's first line, by its number in the file as it is now; where removed lines were, for one that only removes. */
export function startOf(rows: Row[]): number | undefined {
  const first = rows.find((r): r is Line => r.kind !== 'hunk')
  return first?.new ?? first?.old
}

/**
 * A file's changed lines, for showing it whole: those added, by their number now, and where lines were taken out,
 * by the line now after them, with how many.
 */
export function changedLines(hunks: ReviewHunk[]): { added: Set<number>; removed: Map<number, number> } {
  const added = new Set<number>()
  const removed = new Map<number, number>()
  for (const hunk of hunks) {
    let taken = 0
    let last = 0
    for (const r of rowsFor(hunk)) {
      if (r.kind === 'hunk') continue
      if (r.kind === 'del') {
        taken++
        continue
      }
      if (taken) removed.set(r.new!, (removed.get(r.new!) ?? 0) + taken)
      taken = 0
      last = r.new!
      if (r.kind === 'add') added.add(r.new!)
    }
    // Taken out at the end of the hunk: after its last line.
    if (taken) removed.set(last + 1, (removed.get(last + 1) ?? 0) + taken)
  }
  return { added, removed }
}
