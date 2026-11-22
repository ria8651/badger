import { createSignal } from 'solid-js'
import type { QuickAction } from '../shared/protocol.ts'
import { api, socket } from './api.ts'

/**
 * The prompts in the composer's quick actions menu, set up in Settings and
 * kept on the hub, so each device has the same ones. Kept current over the socket.
 */
const [list, setList] = createSignal<QuickAction[]>([])
export const quickActions = list

/** Saves not yet answered, and the newest list the hub sent meanwhile. */
let pending = 0
let held: QuickAction[] | undefined

socket.on((e) => {
  if (e.type !== 'quick_actions') return
  // While saves are on their way, the hub's echoes of the earlier ones would undo the later ones shown here,
  // and the next edit would build on that. Only the last one sent counts, once they're all answered.
  if (pending) held = e.actions
  else setList(e.actions)
})

/** Shown straight away; the hub then sends it back to every tab, this one included. */
export async function saveQuickActions(actions: QuickAction[]): Promise<void> {
  pending++
  setList(actions)
  try {
    await api.setQuickActions(actions)
  } catch (err) {
    // What the hub has now, in place of what couldn't be saved.
    held = await api.quickActions().catch(() => held)
    throw err
  } finally {
    if (!--pending && held) {
      setList(held)
      held = undefined
    }
  }
}
