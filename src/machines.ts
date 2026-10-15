import { createSignal } from 'solid-js'
import { LOCAL_MACHINE, type Machine } from '../shared/protocol.ts'
import { socket } from './api.ts'

export const LOCAL = LOCAL_MACHINE

/** Every runner, the hub's own first, kept current over the socket. */
const [list, setList] = createSignal<Machine[]>([])
export const machines = list

/** Names runners have gone by, kept so one that's been removed can still be called what it was. */
const NAMES_KEY = 'badger.machineNames'
const names: Record<string, string> = (() => {
  try {
    return JSON.parse(localStorage.getItem(NAMES_KEY) ?? '{}')
  } catch {
    return {}
  }
})()

socket.on((e) => {
  if (e.type !== 'machines') return
  // Before the list, so anything it wakes up finds the new names.
  if (e.machines.some((m) => names[m.id] !== m.name)) {
    for (const m of e.machines) names[m.id] = m.name
    localStorage.setItem(NAMES_KEY, JSON.stringify(names))
  }
  setList(e.machines)
})

export const machineOf = (id?: string) => list().find((m) => m.id === (id || LOCAL))

/** What a runner is called, or was before it was removed, if this browser ever saw it. */
export const knownName = (id?: string): string | undefined => machineOf(id)?.name ?? names[id || LOCAL]

/** What a runner is called; a stand-in for one removed before this browser learned its name. */
export const machineName = (id?: string) => knownName(id) ?? 'Removed runner'

/** Connected now. Until the list arrives everything counts as online, so nothing flashes up as offline. */
export const isOnline = (id?: string) => !list().length || !!machineOf(id)?.online

/** No longer one of the hub's runners. Like being offline, not until the list arrives. */
export const isRemoved = (id?: string) => !!list().length && !machineOf(id)

/** With only the hub's own runner there's no need to say where anything runs. */
export const severalMachines = () => list().length > 1

/** Which runner something's on, once there's more than one to tell apart, or it's on one that's gone; empty otherwise. */
export const onMachine = (id?: string) => (severalMachines() || isRemoved(id) ? machineName(id) : '')
