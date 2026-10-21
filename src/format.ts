/** Formatting for counts, shared by components and plain modules. */

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** A count in few characters, e.g. 12.3K. */
export const compact = (n: number) => new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(n)

/** How long ago, roughly: "just now", "5m ago", "3h ago", "2d ago". */
export const ago = (ms: number) => {
  const s = Math.max(0, (Date.now() - ms) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}
