/** Formatting for counts, shared by components and plain modules. */

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** A count in few characters, e.g. 12.3K. */
export const compact = (n: number) => new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(n)
