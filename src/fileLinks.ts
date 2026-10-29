import { createContext, useContext } from 'solid-js'

/** Opens a file beside the chat, at a line if given; `cwd` is what relative links are from. Absent where there's nowhere to open one. */
export const OpenFile = createContext<{ open: (path: string, line?: number) => void; cwd: () => string | undefined }>()
export const useOpenFile = () => useContext(OpenFile)

/**
 * The file a link is to, as an absolute path, and the line if it says one: `src/a.ts`, `./a.ts:12`, `/abs/a.ts#L12`,
 * `file:///abs/a.ts`. Relative ones are from `cwd`. Undefined for anything else: a web page, a mailto, an anchor.
 */
export function fileLink(href: string, cwd: string | undefined): { path: string; line?: number } | undefined {
  let raw = href.trim()
  if (!raw || raw.startsWith('#') || raw.startsWith('//')) return
  if (/^file:\/\//i.test(raw)) raw = raw.replace(/^file:\/\/(localhost)?/i, '')
  else if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return
  try {
    raw = decodeURI(raw)
  } catch {
    // Left as it is: a stray % is more likely part of the name than an escape.
  }
  let line: number | undefined
  const hash = /#L(\d+)(?:-L?\d+)?$/i.exec(raw)
  if (hash) {
    line = Number(hash[1])
    raw = raw.slice(0, hash.index)
  } else {
    raw = raw.replace(/#.*$/, '')
    // path:12 or path:12:5, as compilers and Claude write them.
    const colon = /:(\d+)(?::\d+)?$/.exec(raw)
    if (colon) {
      line = Number(colon[1])
      raw = raw.slice(0, colon.index)
    }
  }
  raw = raw.replace(/\?.*$/, '')
  if (!raw) return
  if (!raw.startsWith('/')) {
    if (!cwd) return
    raw = `${cwd.replace(/\/$/, '')}/${raw}`
  }
  return { path: normalize(raw), line }
}

/** `.` and `..` worked out, and doubled slashes made one. */
function normalize(path: string): string {
  const out: string[] = []
  for (const part of path.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return `/${out.join('/')}`
}
