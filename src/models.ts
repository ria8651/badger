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

/** Families from most to least capable, which is how the picker orders them. */
const FAMILIES = ['fable', 'opus', 'sonnet', 'haiku']

/** A model's family and version from its name, like "Opus 4.8" or claude-opus-4-8. */
function parse(name: string): { family: string; version: number[] } | undefined {
  const m = /^(?:claude-)?([a-z]+)[ -](\d+)(?:[.-](\d{1,2}))?\b/i.exec(name)
  return m ? { family: m[1].toLowerCase(), version: [Number(m[2]), Number(m[3] ?? 0)] } : undefined
}

/** A readable name for a model id Claude Code no longer offers: claude-opus-4-1-20250805 is "Opus 4.1". */
export function modelName(id: string): string {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(id)
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ''}` : id
}

export interface ModelChoice {
  value: string
  label: string
  description?: string
  /** Not the newest of its family, so tucked under "Older models". */
  older?: boolean
}

/**
 * Claude Code's models in the picker's order: Default, the newest of each family from most capable down,
 * then every older version, newest first.
 */
export function modelChoices(options: ModelOption[]): ModelChoice[] {
  const rank = (family?: string) => {
    const i = family ? FAMILIES.indexOf(family) : -1
    return i < 0 ? FAMILIES.length : i
  }
  const choices = options.map((o) => ({
    value: o.value,
    label: o.value === 'default' ? 'Default' : o.displayName.replace(/ \(.*\)$/, ''),
    description: o.description,
    parsed: o.value === 'default' ? undefined : parse(o.displayName),
  }))
  const newest = new Map<string, number[]>()
  for (const { parsed } of choices) {
    if (parsed && compare(parsed.version, newest.get(parsed.family)) > 0) newest.set(parsed.family, parsed.version)
  }
  const older = (c: (typeof choices)[number]) => !!c.parsed && compare(c.parsed.version, newest.get(c.parsed.family)) < 0
  return choices
    .map((c, i) => ({ c, i, older: older(c) }))
    .sort(
      (a, b) =>
        +(a.c.value !== 'default') - +(b.c.value !== 'default') ||
        +a.older - +b.older ||
        rank(a.c.parsed?.family) - rank(b.c.parsed?.family) ||
        (a.c.parsed && b.c.parsed ? compare(b.c.parsed.version, a.c.parsed.version) : 0) ||
        a.i - b.i,
    )
    .map(({ c, older }) => ({ value: c.value, label: c.label, description: c.description, older: older || undefined }))
}

function compare(a: number[], b: number[] | undefined): number {
  if (!b) return 1
  return a[0] - b[0] || a[1] - b[1]
}
