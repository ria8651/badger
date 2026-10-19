import { createContext, createMemo, useContext, type Accessor } from 'solid-js'
import { unwrap } from 'solid-js/store'
import type { WireMessage } from '../../shared/protocol.ts'
import { affectsTasks, collectTasks } from '../tasks.ts'
import { collectContext, collectResults, type Block, type Index } from './model.ts'

/** The chat's index, for everything in its transcript, nested subagents included. */
export const TranscriptIndex = createContext<Accessor<Index>>()
export const useIndex = () => useContext(TranscriptIndex)!
export const NONE: WireMessage[] = []

/**
 * Index a chat's messages, as they arrive. Messages only ever arrive at the end, so each new one is added to
 * what's indexed already rather than the whole chat being walked again; a fresh snapshot, a new array, starts
 * over. Tracks the array and its length, then walks the raw objects so the cache keys are stable.
 */
export function createIndex(messages: () => WireMessage[], sessionId?: () => string | undefined): Accessor<Index> {
  let indexed: WireMessage[] | undefined
  let count = 0
  let index: Index | undefined
  return createMemo(() => {
    void messages().length
    const all = unwrap(messages())
    const id = sessionId?.()
    if (!index || all !== indexed || all.length < count || index.sessionId !== id) {
      index = { sessionId: id, groups: new Map(), results: new Map(), tasks: new Map(), parents: new Map(), uses: new Map(), context: new Map() }
      indexed = all
      count = 0
    }
    const fresh = all.slice(count)
    count = all.length
    // A group that grows is a new array, so whatever reads it sees it change; the rest stay as they were.
    const grown = new Set<string>()
    const { groups, results, parents, uses, context } = index
    for (const m of fresh) {
      if (typeof m.tool_use_id === 'string' && m.type !== 'system') {
        collectContext(m, context)
        continue
      }
      const parent = (m.parent_tool_use_id as string | null | undefined) ?? ''
      if (!grown.has(parent)) {
        groups.set(parent, [...(groups.get(parent) ?? [])])
        grown.add(parent)
      }
      groups.get(parent)!.push(m)
      if (m.type === 'user') collectResults(m, results)
      if (m.type !== 'assistant') continue
      for (const b of ((m.message as { content?: Block[] })?.content ?? []) as Block[]) {
        if (b.type !== 'tool_use' || !b.id) continue
        parents.set(b.id, parent)
        uses.set(b.id, { name: b.name ?? '?', input: b.input ?? {} })
      }
    }
    // Tasks are told by a few kinds of message, but each changes what an earlier one started, so they're read again.
    const tasks = !fresh.length || (count > fresh.length && !fresh.some(affectsTasks)) ? index.tasks : collectTasks(all)
    index = { ...index, tasks }
    return index
  })
}
