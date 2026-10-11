import { createRoot, createResource, createSignal } from 'solid-js'
import type { ModelOption } from '../shared/protocol.ts'
import { api, socket } from './api.ts'

const LAST_KEY = 'badger.model'

/** What Claude Code offers, fetched once, or again on reconnecting if that failed. */
export const models = createRoot(() => {
  const [list, { refetch }] = createResource(() => api.models().catch(() => [] as ModelOption[]))
  socket.onConnection((c) => c && !list.loading && !list()?.length && refetch())
  return list
})

/** The model last picked, which new chats start on. */
const [last, setLast] = createSignal(localStorage.getItem(LAST_KEY) ?? 'default')
export const lastModel = last
export const setLastModel = (model: string) => {
  setLast(model)
  localStorage.setItem(LAST_KEY, model)
}

/**
 * The option a chat's model is: itself, or for a model id from a transcript,
 * the alias it resolves from. "Default" is skipped there, since the transcript
 * says which model actually answered.
 */
export function modelValue(model: string, options: ModelOption[]): string {
  if (options.some((o) => o.value === model)) return model
  return options.find((o) => o.value !== 'default' && o.resolvedModel === model)?.value ?? model
}
