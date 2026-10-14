import { createSignal } from 'solid-js'
import { LOCAL_MACHINE, type Machine } from '../shared/protocol.ts'
import { socket } from './api.ts'

export const LOCAL = LOCAL_MACHINE

/** Every runner, the hub's own first, kept current over the socket. */
const [list, setList] = createSignal<Machine[]>([])
export const machines = list

socket.on((e) => {
  if (e.type === 'machines') setList(e.machines)
})

export const machineOf = (id?: string) => list().find((m) => m.id === (id || LOCAL))

/** What a runner is called; its id if it's been removed. */
export const machineName = (id?: string) => machineOf(id)?.name ?? id ?? ''

/** Connected now. Until the list arrives everything counts as online, so nothing flashes up as offline. */
export const isOnline = (id?: string) => !list().length || !!machineOf(id)?.online

/** With only the hub's own runner there's no need to say where anything runs. */
export const severalMachines = () => list().length > 1

/** Which runner something's on, once there's more than one to tell apart; empty otherwise. */
export const onMachine = (id?: string) => (severalMachines() ? machineName(id) : '')
