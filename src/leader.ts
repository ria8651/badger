import { createSignal, onCleanup } from 'solid-js'
import { modalOpen } from './components/ui.tsx'
import { isLeader } from './layout.ts'

/**
 * Shortcuts that start with the leader chord, Cmd+K on a Mac and Ctrl+K elsewhere, then one key. The page has
 * some everywhere, and a chat's panels add theirs while it's open.
 */
export interface LeaderKey {
  /** The keys, as KeyboardEvent.key has them; letters in lower case. */
  keys: string[]
  /** What the menu shown after the chord lists it as: the key, and what it does. Keys sharing a line leave it off but one. */
  hint?: [string, string]
  run: () => void
}

const [sets, setSets] = createSignal<(() => LeaderKey[])[]>([])
const [waiting, setWaiting] = createSignal(false)
/** The chord's been pressed, and the next key is for it. */
export { waiting as leaderWaiting }

/** Adds keys for as long as the calling component is there. */
export function leaderKeys(keys: () => LeaderKey[]): void {
  setSets((s) => [...s, keys])
  onCleanup(() => setSets((s) => s.filter((k) => k !== keys)))
}

/** Every key there is now, in the order they were added. */
export const leaderBindings = () => sets().flatMap((k) => k())

const onKey = (e: KeyboardEvent) => {
  // Behind a modal: its keys are its own.
  if (modalOpen()) return setWaiting(false)
  if (!waiting()) {
    if (!isLeader(e)) return
    // Caught on the way down, so neither the composer nor a terminal sees it.
    e.preventDefault()
    e.stopPropagation()
    setWaiting(true)
    return
  }
  if (['Shift', 'Meta', 'Control', 'Alt'].includes(e.key)) return
  e.preventDefault()
  e.stopPropagation()
  setWaiting(false)
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key
  leaderBindings()
    .find((b) => b.keys.includes(key))
    ?.run()
}
const cancel = () => setWaiting(false)
addEventListener('keydown', onKey, true)
addEventListener('pointerdown', cancel)
addEventListener('blur', cancel)
