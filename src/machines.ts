import { createSignal } from 'solid-js'
import type { Machine } from '../shared/protocol.ts'
import { socket } from './api.ts'

/** The hub's own machine. */
export const LOCAL = 'local'

/** Every machine, kept current over the socket. */
const [list, setList] = createSignal<Machine[]>([])
export const machines = list

socket.on((e) => {
  if (e.type === 'machines') setList(e.machines)
})

export const machineOf = (id?: string) => list().find((m) => m.id === (id || LOCAL))

/** What a machine is called; its id if it's been removed. */
export const machineName = (id?: string) => machineOf(id)?.name ?? id ?? ''

/** Connected now. Until the list arrives everything counts as online, so nothing flashes up as offline. */
export const isOnline = (id?: string) => !list().length || !!machineOf(id)?.online

/** With only the hub's own machine, there's no need to say which machine anything is on. */
export const severalMachines = () => list().length > 1
