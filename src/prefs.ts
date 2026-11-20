import { createSignal } from 'solid-js'

/** How much of Claude's work chats show: all of it, or results with the work between folded away. */
export type Detail = 'full' | 'result'

const DETAIL_KEY = 'badger.chatDetail'
const [detail, setDetailSignal] = createSignal<Detail>(localStorage.getItem(DETAIL_KEY) === 'result' ? 'result' : 'full')
export { detail }

/** One setting for every chat, kept in this browser. */
export function setDetail(next: Detail): void {
  setDetailSignal(next)
  localStorage.setItem(DETAIL_KEY, next)
}

export const toggleDetail = () => setDetail(detail() === 'full' ? 'result' : 'full')

const WRAP_KEY = 'badger.fileWrap'
const [wrap, setWrapSignal] = createSignal(localStorage.getItem(WRAP_KEY) === '1')
export { wrap }

/** Whether files and Claude's code blocks wrap their long lines: one setting for all of them, left as it was last used in this browser. */
export function toggleWrap(): void {
  setWrapSignal(!wrap())
  localStorage.setItem(WRAP_KEY, wrap() ? '1' : '0')
}

/**
 * What a diff marks over its lines' tint: the characters that changed in every changed line, a new or removed one
 * all over; or only in lines that were edited, where it's the words that changed, which say the most.
 */
export type DiffMarks = 'all' | 'edits'

const MARKS_KEY = 'badger.diffMarks'
const [diffMarks, setDiffMarksSignal] = createSignal<DiffMarks>(localStorage.getItem(MARKS_KEY) === 'all' ? 'all' : 'edits')
export { diffMarks }

/** One setting for every diff, kept in this browser. */
export function setDiffMarks(next: DiffMarks): void {
  setDiffMarksSignal(next)
  localStorage.setItem(MARKS_KEY, next)
}
