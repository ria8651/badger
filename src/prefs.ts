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
