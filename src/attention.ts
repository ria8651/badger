import { createMemo, createRoot, createSignal } from 'solid-js'
import type { AttentionState } from '../shared/protocol.ts'
import { socket } from './api.ts'
import { sessions } from './stores/sessions.ts'

/** Chats that need the user, by id, as the server last said. */
const [attention, setAttention] = createSignal<Record<string, AttentionState>>({})
export { attention }

/** How many chats need the user. Archived ones are put away, so they don't count. */
export const needsYou = createRoot(() =>
  createMemo(() => {
    const archived = new Set(sessions().flatMap((s) => (s.archived ? [s.id] : [])))
    return Object.keys(attention()).filter((id) => !archived.has(id)).length
  }),
)

/** Called for each chat that newly needs the user, but not for what was already pending when the page loaded. */
type Listener = (sessionId: string, state: AttentionState) => void
const listeners = new Set<Listener>()
let loaded = false

socket.on((e) => {
  if (e.type !== 'attention') return
  const before = attention()
  setAttention(e.chats)
  if (!loaded) return void (loaded = true)
  for (const [id, state] of Object.entries(e.chats)) if (before[id] !== state) for (const l of listeners) l(id, state)
})

export function onAttention(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The user is looking at the page, not just has it open somewhere. */
const [looking, setLooking] = createSignal(document.visibilityState === 'visible' && document.hasFocus())
const look = () => setLooking(document.visibilityState === 'visible' && document.hasFocus())
addEventListener('focus', look)
addEventListener('blur', look)
document.addEventListener('visibilitychange', look)
export { looking }

// ── Browser notifications ──

const NOTIFY_KEY = 'badger.notify'
const supported = typeof Notification !== 'undefined'

const [permission, setPermission] = createSignal<NotificationPermission>(supported ? Notification.permission : 'denied')
const [wanted, setWanted] = createSignal(localStorage.getItem(NOTIFY_KEY) === '1')

/** On, off, or blocked: unsupported here (needs https or localhost) or refused in the browser's settings. */
export const notifications = () => (permission() === 'denied' ? 'blocked' : wanted() && permission() === 'granted' ? 'on' : 'off')

/** Asks the browser for permission the first time, so it has to run from a click. */
export async function toggleNotifications(): Promise<void> {
  if (notifications() === 'on') {
    setWanted(false)
    localStorage.removeItem(NOTIFY_KEY)
    return
  }
  if (!supported) return
  setPermission(Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission)
  if (permission() !== 'granted') return
  setWanted(true)
  localStorage.setItem(NOTIFY_KEY, '1')
}

/**
 * Shows an OS notification, unless the user is looking at the page: then the
 * sidebar already shows it. Every open tab calls this; the tag makes the
 * browser show one per chat rather than one per tab.
 */
export function notify(sessionId: string, title: string, body: string, onClick: () => void): void {
  if (notifications() !== 'on' || looking()) return
  const n = new Notification(title, { body, tag: sessionId })
  n.onclick = () => {
    focus()
    onClick()
    n.close()
  }
}
