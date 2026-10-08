import { For, Show, createMemo, createSignal, type JSX } from 'solid-js'
import { unwrap } from 'solid-js/store'
import { Columns3 } from 'lucide-solid'
import { parseCardContext, type CardContext } from '../../shared/cardContext.ts'
import type { WireMessage } from '../../shared/protocol.ts'
import type { Partial } from '../useChat.ts'
import { STATUS_LABELS } from './Board.tsx'
import { Markdown } from './Markdown.tsx'
import { Disclosure, Pre, ToolCard, toolLabel, type ToolResult } from './ToolCard.tsx'
import { LiveDot } from './ui.tsx'

type Block = { type: string; text?: string; thinking?: string; id?: string; name?: string; input?: Record<string, unknown> }
type ContentBlock = Block & { tool_use_id?: string; content?: unknown; is_error?: boolean }

type Item =
  | { kind: 'user'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool'; id: string; name: string; input: Record<string, unknown> }
  | { kind: 'result'; ok: boolean; seconds: number; tokens?: { input: number; output: number }; endedAt?: number; error?: string }
  | { kind: 'divider'; text: string }
  | { kind: 'card'; context: CardContext }

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
        tokens: turnTokens(m.usage),
        endedAt: typeof m.ended_at === 'number' ? m.ended_at : undefined,
        error: ok ? undefined : String(m.subtype === 'success' ? (m.result ?? 'Error') : m.subtype),
      },
    ]
  }
  if (m.type === 'hook_context') {
    // Other hooks' context isn't Badger's to show.
    const context = parseCardContext(String(m.text ?? ''))
    return context ? [{ kind: 'card', context }] : []
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

export function Transcript(props: {
  messages: WireMessage[]
  partial: Partial | null
  bashOutput: Record<string, string>
  running: boolean
  cwd?: string
}) {
  // Track the array and its length, then walk the raw objects so the cache keys are stable.
  const view = createMemo(() => {
    void props.messages.length
    return buildView(unwrap(props.messages))
  })

  // Block layout so vertical margins collapse: prose breathes, tool rows stack tightly.
  const render = (item: Item): JSX.Element => {
    switch (item.kind) {
      case 'user':
        return (
          <div class="mt-8 mb-4 flex justify-end first:mt-0">
            <div class="max-w-[80%] bg-surface rounded-2xl px-4 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap">{item.text}</div>
          </div>
        )
      case 'text':
        return (
          <div class="my-4">
            <Markdown text={item.text} />
          </div>
        )
      case 'thinking':
        return <Thinking text={item.text} />
      case 'tool':
        return (
          <ToolCard
            name={item.name}
            input={item.input}
            result={view().results.get(item.id)}
            liveOutput={props.bashOutput[item.id]}
            running={props.running}
            cwd={props.cwd}
            subagentSteps={view().subagentSteps.get(item.id)}
          />
        )
      case 'result':
        return (
          <div class={`mt-4 text-xs tabular-nums ${item.ok ? 'text-fg-3' : 'text-danger'}`}>
            {item.ok ? '' : `Stopped: ${item.error} · `}
            {duration(item.seconds)}
            {item.tokens ? ` · ${compact(item.tokens.input)} in · ${compact(item.tokens.output)} out` : ''}
            <Show when={item.endedAt}>{(at) => <Ago time={at()} />}</Show>
          </div>
        )
      case 'divider':
        return (
          <div class="my-8 flex items-center gap-3 text-xs text-fg-3">
            <div class="h-px flex-1 bg-line" />
            {item.text}
            <div class="h-px flex-1 bg-line" />
          </div>
        )
      case 'card':
        return <CardContextBadge context={item.context} />
    }
  }

  return (
    <div>
      <For each={view().items}>{render}</For>
      <Show when={props.partial?.type === 'text' && props.partial.text}>
        <div class="my-4">
          <Markdown text={props.partial?.text ?? ''} />
        </div>
      </Show>
      <Show when={props.partial?.type === 'thinking'}>
        <Thinking text={props.partial?.text ?? ''} live />
      </Show>
      <Show when={props.partial?.type === 'tool_use'}>
        <Disclosure label={props.partial?.toolName ? toolLabel(props.partial.toolName) : 'Tool'} trailing={<LiveDot />} live>
          <Pre text={props.partial?.text ?? ''} />
        </Disclosure>
      </Show>
    </div>
  )
}

/** The card Claude was told about with this message, as a badge on the user's side linking to it. */
function CardContextBadge(props: { context: CardContext }) {
  const badge = 'inline-flex max-w-[80%] items-center gap-2 rounded-full border border-line px-3 py-1 text-[13px]'
  return (
    <div class="-mt-2 mb-4 flex justify-end">
      <Show when={props.context.card} fallback={<span class={`${badge} text-fg-3`}><Columns3 class="size-3.5" />No longer on a card</span>}>
        {(card) => (
          <a
            href={`/c/${card().id}`}
            onClick={(e) => {
              if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
              e.preventDefault()
              // App routes on popstate, so this navigates without a reload.
              history.pushState(null, '', `/c/${card().id}`)
              dispatchEvent(new PopStateEvent('popstate'))
            }}
            class={`${badge} text-fg-2 transition-colors hover:bg-surface hover:text-fg`}
          >
            <Columns3 class="size-3.5 shrink-0 text-fg-3" />
            <span class="min-w-0 truncate">
              <span class="text-fg-3">#{card().id}</span> {card().title}
            </span>
            <span class="shrink-0 text-xs text-fg-3">{STATUS_LABELS[card().status]}</span>
          </a>
        )}
      </Show>
    </div>
  )
}

function Thinking(props: { text: string; live?: boolean }) {
  return (
    <Disclosure label={props.live ? 'Thinking' : 'Thought'} trailing={props.live && <LiveDot />} live={props.live}>
      <div class="text-[13px] leading-relaxed whitespace-pre-wrap text-fg-2">{props.text}</div>
    </Disclosure>
  )
}

type Usage = { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }

/** Tokens for one turn, cached input included. Main agent only; subagents aren't counted. */
function turnTokens(usage: unknown): { input: number; output: number } | undefined {
  const u = usage as Usage | undefined
  if (!u || typeof u.output_tokens !== 'number') return undefined
  return {
    input: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
    output: u.output_tokens,
  }
}

const compact = (n: number) => new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(n)

/** 42s, 5m 3s, 1h 12m. */
function duration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  return h ? `${h}h ${m}m` : `${m}m ${seconds % 60}s`
}

/** Ticks once a minute for every <Ago> on the page. */
const [now, setNow] = createSignal(Date.now())
setInterval(() => setNow(Date.now()), 60_000)

function Ago(props: { time: number }) {
  const label = () => {
    const minutes = Math.floor((now() - props.time) / 60_000)
    if (minutes < 1) return 'just now'
    if (minutes < 60) return `${minutes}m ago`
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return `${hours}h ago`
    return `${Math.floor(hours / 24)}d ago`
  }
  return <span title={new Date(props.time).toLocaleString()}>{` · ${label()}`}</span>
}
