import { For, Show, createMemo, createSignal, type JSX } from 'solid-js'
import { unwrap } from 'solid-js/store'
import { Brain, ChevronRight } from 'lucide-solid'
import type { WireMessage } from '../../shared/protocol.ts'
import type { Partial } from '../useChat.ts'
import { Markdown } from './Markdown.tsx'
import { ToolCard, type ToolResult } from './ToolCard.tsx'

type Block = { type: string; text?: string; thinking?: string; id?: string; name?: string; input?: Record<string, unknown> }
type ContentBlock = Block & { tool_use_id?: string; content?: unknown; is_error?: boolean }

type Item =
  | { kind: 'user'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool'; id: string; name: string; input: Record<string, unknown> }
  | { kind: 'result'; ok: boolean; seconds: number; cost?: number; error?: string }
  | { kind: 'divider'; text: string }

/**
 * Items per message, cached by message identity so <For> keeps existing rows
 * (and their open/closed state) when new messages arrive.
 */
const itemCache = new WeakMap<WireMessage, Item[]>()

function itemsFor(m: WireMessage): Item[] {
  let items = itemCache.get(m)
  if (!items) itemCache.set(m, (items = messageItems(m)))
  return items
}

function messageItems(m: WireMessage): Item[] {
  if (m.parent_tool_use_id) return []
  if (m.type === 'user') {
    if (m.isMeta || m.isSynthetic) return []
    const text = userText(m)
    return text ? [{ kind: 'user', text }] : []
  }
  if (m.type === 'assistant') {
    const content = ((m.message as { content?: Block[] })?.content ?? []) as Block[]
    const items: Item[] = []
    for (const b of content) {
      if (b.type === 'text' && b.text?.trim()) items.push({ kind: 'text', text: b.text })
      else if (b.type === 'thinking' && b.thinking?.trim()) items.push({ kind: 'thinking', text: b.thinking })
      else if (b.type === 'tool_use' && b.id) items.push({ kind: 'tool', id: b.id, name: b.name ?? '?', input: b.input ?? {} })
    }
    return items
  }
  if (m.type === 'result') {
    const ok = m.subtype === 'success' && !m.is_error
    return [
      {
        kind: 'result',
        ok,
        seconds: Math.round(Number(m.duration_ms ?? 0) / 1000),
        cost: typeof m.total_cost_usd === 'number' ? m.total_cost_usd : undefined,
        error: ok ? undefined : String(m.subtype === 'success' ? (m.result ?? 'Error') : m.subtype),
      },
    ]
  }
  if (m.type === 'system' && m.subtype === 'compact_boundary') return [{ kind: 'divider', text: 'Conversation compacted' }]
  return []
}

/** Turn raw SDK messages into renderable items plus a tool_use_id → result map. */
function buildView(messages: WireMessage[]) {
  const results = new Map<string, ToolResult>()
  const subagentSteps = new Map<string, number>()
  for (const m of messages) {
    const parent = m.parent_tool_use_id as string | null | undefined
    if (parent && m.type === 'assistant') subagentSteps.set(parent, (subagentSteps.get(parent) ?? 0) + 1)
    if (parent || m.type === 'user') collectResults(m, results)
  }
  return { items: messages.flatMap(itemsFor), results, subagentSteps }
}

function collectResults(m: WireMessage, results: Map<string, ToolResult>) {
  const content = (m.message as { content?: unknown })?.content
  if (!Array.isArray(content)) return
  for (const b of content as ContentBlock[]) {
    if (b.type === 'tool_result' && b.tool_use_id) results.set(b.tool_use_id, { content: b.content, isError: !!b.is_error })
  }
}

function userText(m: WireMessage): string {
  const content = (m.message as { content?: unknown })?.content
  const raw =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? (content as ContentBlock[]).filter((b) => b.type === 'text').map((b) => b.text).join('\n')
        : ''
  const command = raw.match(/<command-name>(.*?)<\/command-name>/)
  if (command) return command[1]
  // Harness-injected content (system reminders, command output) is wrapped in tags.
  if (raw.trimStart().startsWith('<')) return ''
  return raw
}

export function Transcript(props: { messages: WireMessage[]; partial: Partial | null; running: boolean; cwd?: string }) {
  // Track the array and its length, then walk the raw objects so the cache keys are stable.
  const view = createMemo(() => {
    void props.messages.length
    return buildView(unwrap(props.messages))
  })

  const render = (item: Item): JSX.Element => {
    switch (item.kind) {
      case 'user':
        return (
          <div class="flex justify-end">
            <div class="max-w-[85%] rounded-2xl bg-zinc-100 px-4 py-2 whitespace-pre-wrap dark:bg-zinc-800">{item.text}</div>
          </div>
        )
      case 'text':
        return <Markdown text={item.text} />
      case 'thinking':
        return <Thinking text={item.text} />
      case 'tool':
        return (
          <ToolCard
            name={item.name}
            input={item.input}
            result={view().results.get(item.id)}
            running={props.running}
            cwd={props.cwd}
            subagentSteps={view().subagentSteps.get(item.id)}
          />
        )
      case 'result':
        return (
          <div class={`text-xs ${item.ok ? 'text-zinc-400' : 'text-red-600'}`}>
            {item.ok ? 'Done' : `Stopped: ${item.error}`} · {item.seconds}s{item.cost != null ? ` · $${item.cost.toFixed(4)}` : ''}
          </div>
        )
      case 'divider':
        return (
          <div class="flex items-center gap-3 text-xs text-zinc-400">
            <div class="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" />
            {item.text}
            <div class="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" />
          </div>
        )
    }
  }

  return (
    <div class="space-y-3">
      <For each={view().items}>{render}</For>
      <Show when={props.partial?.type === 'text' && props.partial.text}>
        <Markdown text={props.partial?.text ?? ''} />
      </Show>
      <Show when={props.partial?.type === 'thinking'}>
        <Thinking text={props.partial?.text ?? ''} live />
      </Show>
      <Show when={props.partial?.type === 'tool_use'}>
        <div class="text-sm text-zinc-500">Preparing {props.partial?.toolName}…</div>
      </Show>
    </div>
  )
}

function Thinking(props: { text: string; live?: boolean }) {
  const [open, setOpen] = createSignal(false)
  return (
    <div class="text-sm text-zinc-500">
      <button onClick={() => setOpen(!open())} class="flex items-center gap-1.5 hover:text-zinc-700 dark:hover:text-zinc-300">
        <Brain class={`size-3.5 ${props.live ? 'animate-pulse' : ''}`} />
        {props.live ? 'Thinking…' : 'Thought'}
        <ChevronRight class={`size-3.5 transition-transform ${open() ? 'rotate-90' : ''}`} />
      </button>
      <Show when={open()}>
        <div class="mt-1 border-l-2 border-zinc-200 pl-3 whitespace-pre-wrap dark:border-zinc-800">{props.text}</div>
      </Show>
    </div>
  )
}
