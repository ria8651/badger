import { createContext, createMemo, useContext, type Accessor } from 'solid-js'
import { unwrap } from 'solid-js/store'
import type { WireMessage } from '../../shared/protocol.ts'
import { affectsTasks, collectTasks } from '../tasks.ts'
import { agentIdIn, collectContext, collectResults, sentToSubagent, type Block, type Index } from './model.ts'

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
      index = { sessionId: id, groups: new Map(), results: new Map(), tasks: new Map(), parents: new Map(), uses: new Map(), context: new Map(), agents: new Map() }
      indexed = all
      count = 0
    }
    const fresh = all.slice(count)
    count = all.length
    // A group that grows is a new array, so whatever reads it sees it change; the rest stay as they were.
    const grown = new Set<string>()
    const { groups, results, parents, uses, context, agents } = index
    const group = (key: string) => {
      if (!grown.has(key)) {
        groups.set(key, [...(groups.get(key) ?? [])])
        grown.add(key)
      }
      return groups.get(key)!
    }
    for (const m of fresh) {
      if (typeof m.tool_use_id === 'string' && m.type !== 'system') {
        collectContext(m, context)
        continue
      }
      const parent = groupOf(m, agents)
      if (parent) place(group(parent), m)
      else group(parent).push(m)
      if (m.type === 'user') {
        collectResults(m, results)
        learnAgents(m, uses, agents)
      }
      if (m.type !== 'assistant') continue
      for (const b of ((m.message as { content?: Block[] })?.content ?? []) as Block[]) {
        if (b.type !== 'tool_use' || !b.id) continue
        parents.set(b.id, parent)
        uses.set(b.id, { name: b.name ?? '?', input: b.input ?? {}, at: timeOf(m) })
        const sent = sentBy(m, b, agents)
        if (sent) place(group(sent.parent_tool_use_id as string), sent)
      }
    }
    // Tasks are told by a few kinds of message, but each changes what an earlier one started, so they're read again.
    const tasks = !fresh.length || (count > fresh.length && !fresh.some(affectsTasks)) ? index.tasks : collectTasks(all)
    index = { ...index, tasks }
    return index
  })
}

/**
 * The group a message goes in: the subagent call it came from, or '' for the chat's own. A subagent sent a message
 * after it finished starts again from the SendMessage call, so its messages go by its agent id where that's known.
 */
function groupOf(m: WireMessage, agents: Map<string, string>): string {
  const parent = (m.parent_tool_use_id as string | null | undefined) ?? ''
  const agent = typeof m.agent_id === 'string' ? m.agent_id : undefined
  if (!agent) return parent
  const call = agents.get(agent)
  if (call) return call
  if (parent) agents.set(agent, parent)
  return parent
}

/** Each Agent call's result names the agent it started, which is how its later messages are known as its. */
function learnAgents(m: WireMessage, uses: Index['uses'], agents: Map<string, string>) {
  const content = (m.message as { content?: unknown })?.content
  if (!Array.isArray(content)) return
  for (const b of content as { type?: string; tool_use_id?: string; content?: unknown }[]) {
    const name = b.type === 'tool_result' && b.tool_use_id ? uses.get(b.tool_use_id)?.name : undefined
    if (name !== 'Agent' && name !== 'Task') continue
    const id = agentIdIn(b.content)
    if (id) agents.set(id, b.tool_use_id!)
  }
}

/**
 * Adds a message to a subagent's group, in time order: read back from disk, a chat's subagents' messages come after
 * all of its own, and what was sent to one shows from the call that sent it. Its own copy of a message sent to it,
 * read back from disk, takes that one's place.
 */
function place(list: WireMessage[], m: WireMessage) {
  const text = sentToSubagent(m)
  const shown = text === undefined || m.relayed ? -1 : list.findIndex((x) => x.relayed && sentToSubagent(x) === text)
  if (shown >= 0) return void (list[shown] = m)
  if (text !== undefined && m.relayed && list.some((x) => !x.relayed && sentToSubagent(x) === text)) return
  const at = timeOf(m)
  let i = list.length
  if (at !== undefined) while (i > 0 && (timeOf(list[i - 1]) ?? -Infinity) > at) i--
  list.splice(i, 0, m)
}

const timeOf = (m: WireMessage) => (typeof m.timestamp === 'string' ? Date.parse(m.timestamp) : undefined)

/**
 * A message Claude sent one of its subagents with SendMessage, as the subagent gets it. Claude Code doesn't stream a
 * subagent the messages sent to it, so without this they'd only show once the chat is read back from disk.
 */
function sentBy(m: WireMessage, b: Block, agents: Map<string, string>): WireMessage | undefined {
  const to = b.input?.to
  const text = b.input?.message
  const call = b.name === 'SendMessage' && typeof to === 'string' ? agents.get(to) : undefined
  if (!call || typeof text !== 'string' || !text.trim()) return undefined
  return {
    type: 'user',
    uuid: `sent:${b.id}`,
    relayed: true,
    timestamp: m.timestamp,
    parent_tool_use_id: call,
    message: { role: 'user', content: `The coordinator sent a message while you were working:\n${text}` },
  }
}
