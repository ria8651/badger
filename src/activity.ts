import { createEffect, createRoot, createSignal, on } from 'solid-js'
import type { ActivityBeat, ClientHello } from '../shared/protocol.ts'
import { socket } from './api.ts'
import { route } from './router.tsx'

/*
 * Time tracking, recorded for later. The hub is told who this tab is, then
 * whether it's on screen and in use, and what's in it: whenever that changes,
 * and every few seconds while it's visible. Whether that time was work is
 * decided when reading it, so nothing here decides what counts.
 */

declare const __BADGER_BUILD__: string | undefined

/** How often a visible tab says it's still there. */
const TICK_MS = 15 * 1000
/** Input after this long without any is the start of activity, so it's sent at once rather than at the next tick. */
const IDLE_EDGE_MS = 10 * 1000
/** Pointer moves count at most this often; they come many times a second. */
const MOVE_MS = 1000

/** A random id. Not crypto.randomUUID: that needs https, which Badger may not be on. */
const randomId = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('')

const CLIENT_KEY = 'badger.client'
/** This browser, across tabs and restarts. */
const client = localStorage.getItem(CLIENT_KEY) ?? randomId()
localStorage.setItem(CLIENT_KEY, client)
/** This page load. Not kept across reloads: a duplicated tab would copy it, and two tabs' beats would mix. */
const tab = randomId()

/** What a chat has on screen, said by its Workspace: the chat and the panels showing beside it. */
const [onScreen, setOnScreen] = createSignal<{ sessionId: string; views: string[] }>()
export { setOnScreen }

let inputs = 0
let keys = 0
/** When the last input was, by this tab's clock. */
let lastInput: number | undefined
let lastMove = 0
let pane: string | undefined

function hello(): ClientHello {
  return {
    client,
    tab,
    info: {
      userAgent: navigator.userAgent,
      platform: (navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform,
      language: navigator.language,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      screen: { width: screen.width, height: screen.height, dpr: devicePixelRatio },
      viewport: { width: innerWidth, height: innerHeight },
      touch: matchMedia('(pointer: coarse)').matches,
      standalone: matchMedia('(display-mode: standalone)').matches,
      build: typeof __BADGER_BUILD__ === 'string' ? __BADGER_BUILD__ : undefined,
    },
  }
}

function state(reason: string): ActivityBeat {
  const r = route()
  const shown = onScreen()
  const sessionId = shown?.sessionId ?? (r.kind === 'chat' ? r.id : undefined)
  return {
    reason,
    visible: document.visibilityState === 'visible',
    // True with focus in a preview's frame too, which takes it from this window.
    focused: document.hasFocus(),
    idleMs: lastInput === undefined ? undefined : Math.max(0, Date.now() - lastInput),
    inputs,
    keys,
    route: r.kind,
    sessionId,
    cardId: r.kind === 'card' ? r.id : undefined,
    views: shown && shown.sessionId === sessionId ? shown.views : [],
    pane,
  }
}

let tick: ReturnType<typeof setTimeout> | undefined

/** Tells the hub how this tab is now. Not while it's offline: it stamps them as they arrive, so late ones would be wrong. */
function beat(reason: string): void {
  clearTimeout(tick)
  if (document.visibilityState === 'visible') tick = setTimeout(() => beat('tick'), TICK_MS)
  if (!socket.connected) return
  socket.send({ type: 'activity', ...state(reason) })
  inputs = keys = 0
}

function input(kind: 'key' | 'pointer' | 'move' | 'wheel', where?: string): void {
  const now = Date.now()
  if (kind === 'move') {
    if (now - lastMove < MOVE_MS) return
    lastMove = now
  }
  const resumed = lastInput === undefined || now - lastInput >= IDLE_EDGE_MS
  // A beat's counts are of input since the one before, in that one's pane; this input is the new pane's, so it's counted after.
  if (where !== undefined && where !== pane) {
    pane = where
    beat('pane')
  } else if (resumed) {
    lastInput = now
    inputs++
    if (kind === 'key') keys++
    return beat('input')
  }
  lastInput = now
  inputs++
  if (kind === 'key') keys++
}

/** The pane an element is in: the chat, a panel by its view key, the sidebar or the page. */
const paneOf = (el: EventTarget | null) => (el instanceof Element ? (el.closest('[data-pane]')?.getAttribute('data-pane') ?? undefined) : undefined)

const opts = { capture: true, passive: true }
addEventListener('keydown', (e) => input('key', paneOf(e.target)), opts)
addEventListener('pointerdown', (e) => input('pointer', paneOf(e.target)), opts)
addEventListener('pointermove', (e) => e.pointerType === 'mouse' && input('move'), opts)
addEventListener('wheel', () => input('wheel'), opts)
// The transcript scrolls itself as Claude writes, so scrolling isn't input; a finger dragging it is.
addEventListener('touchmove', () => input('wheel'), opts)
addEventListener('focusin', (e) => {
  const where = paneOf(e.target)
  if (where && where !== pane) {
    pane = where
    beat('pane')
  }
})
// Previews are other origins, so their input is passed up by the bridge in them (see bridge-page.js).
addEventListener('message', (e) => {
  if (e.data?.type !== 'badger:preview-input') return
  const frame = [...document.querySelectorAll('iframe')].find((f) => f.contentWindow === e.source)
  input(e.data.kind === 'key' ? 'key' : 'pointer', paneOf(frame ?? null))
})
document.addEventListener('visibilitychange', () => beat('visibility'))
addEventListener('focus', () => beat('focus'))
// Focus going into a preview's frame blurs this window but leaves the page focused, so look once it's settled.
addEventListener('blur', () => setTimeout(() => beat('focus')))

socket.onConnection((connected) => {
  if (!connected) return
  socket.send({ type: 'hello', ...hello() })
  beat('open')
})

createRoot(() => {
  createEffect(on(route, () => beat('route'), { defer: true }))
  createEffect(
    on(
      () => JSON.stringify(onScreen() ?? null),
      () => beat('views'),
      { defer: true },
    ),
  )
})

/** Something done in the page that the hub wouldn't otherwise hear of. */
export function track(name: string, sessionId?: string, data?: Record<string, unknown>): void {
  socket.send({ type: 'ui_event', name, sessionId, data })
}
