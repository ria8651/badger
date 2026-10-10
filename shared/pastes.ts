/**
 * Big pastes go to Claude as their own text blocks after the typed message,
 * tagged so the transcript can show them as attachments rather than inline.
 */

/** Pastes at least this long become attachments instead of composer text. */
export const isLongPaste = (text: string) => text.length >= 2000 || text.split('\n').length >= 20

const OPEN = '<pasted-text>\n'
const CLOSE = '\n</pasted-text>'

export const wrapPaste = (text: string) => `${OPEN}${text}${CLOSE}`

/** The pasted text in a block made by wrapPaste, or undefined for any other text. */
export const unwrapPaste = (text: string) =>
  text.startsWith(OPEN) && text.endsWith(CLOSE) ? text.slice(OPEN.length, -CLOSE.length) : undefined
