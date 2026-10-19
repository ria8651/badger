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
