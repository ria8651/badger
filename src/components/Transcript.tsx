import { For, Show, createMemo, createSignal, useContext, type JSX } from 'solid-js'
import { unwrap } from 'solid-js/store'
import { Columns3 } from 'lucide-solid'
import { parseCardContext, type CardContext } from '../../shared/cardContext.ts'
import type { CardStatus, WireMessage } from '../../shared/protocol.ts'
import { ChildChats, type Partial } from '../useChat.ts'
import { STATUS_LABELS } from './Board.tsx'
import { Markdown } from './Markdown.tsx'
import { Disclosure, Pre, ToolCard, resultText, toolLabel, toolSummary, type ToolResult } from './ToolCard.tsx'
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

/** A stretch of Claude's work folded into one row, in result-only mode. */
type Work = { kind: 'work' }
type Row = Item | Work

export type Detail = 'full' | 'result'

const DETAIL_KEY = 'badger.chatDetail'
const [detail, setDetailSignal] = createSignal<Detail>(localStorage.getItem(DETAIL_KEY) === 'result' ? 'result' : 'full')
export { detail }

/** How much of Claude's work chats show. One setting for every chat. */
export function setDetail(next: Detail): void {
  setDetailSignal(next)
  localStorage.setItem(DETAIL_KEY, next)
}

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
  // When the user next spoke after each turn; turns without one are idle until now.
  const idleUntil = new Map<Item, number>()
  let lastResult: Item | undefined
  for (const m of messages) {
    const parent = m.parent_tool_use_id as string | null | undefined
    if (parent && m.type === 'assistant') subagentSteps.set(parent, (subagentSteps.get(parent) ?? 0) + 1)
    if (parent || m.type === 'user') collectResults(m, results)
    const items = itemsFor(m)
    if (m.type === 'result') lastResult = items[0]
    else if (lastResult && items[0]?.kind === 'user' && m.timestamp) {
      idleUntil.set(lastResult, Date.parse(String(m.timestamp)))
      lastResult = undefined
    }
  }
  return { items: messages.flatMap(itemsFor), results, subagentSteps, idleUntil }
}

const isWork = (i: Item) => i.kind === 'text' || i.kind === 'thinking' || i.kind === 'tool'

/** Work rows keyed by their first item, which never changes as the run grows. */
const workCache = new WeakMap<Item, Work>()

/**
 * Result-only rows. In each unbroken run of assistant items, trailing text is
 * the response and stays; everything before it folds into one work row.
 * `tail` is the work row of a run still at the end, the one that can be live.
 */
function foldWork(items: Item[]) {
  const rows: Row[] = []
  const groups = new Map<Work, Item[]>()
  let tail: Work | undefined
  for (let i = 0; i < items.length; ) {
    tail = undefined
    if (!isWork(items[i])) {
      rows.push(items[i++])
      continue
    }
    let end = i
    while (end < items.length && isWork(items[end])) end++
    let reply = end
    while (reply > i && items[reply - 1].kind === 'text') reply--
    if (reply > i) {
      let work = workCache.get(items[i])
      if (!work) workCache.set(items[i], (work = { kind: 'work' }))
      groups.set(work, items.slice(i, reply))
      rows.push(work)
      tail = work
    }
    rows.push(...items.slice(reply, end))
    i = end
  }
  return { rows, groups, tail }
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

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
  /** Running and not stopped on a permission prompt. */
  working: boolean
  cwd?: string
  /** Chats started from tool calls, by tool_use_id; those calls show the child's transcript. */
  children?: Record<string, string>
}) {
  // Track the array and its length, then walk the raw objects so the cache keys are stable.
  const view = createMemo(() => {
    void props.messages.length
    return buildView(unwrap(props.messages))
  })
  const folded = createMemo(() => foldWork(view().items))
  const rows = (): Row[] => (detail() === 'full' ? view().items : folded().rows)

  const partialWork = () => (
    <>
      <Show when={props.partial?.type === 'thinking'}>
        <Thinking text={props.partial?.text ?? ''} live />
      </Show>
      <Show when={props.partial?.type === 'tool_use'}>
        <Disclosure label={props.partial?.toolName ? toolLabel(props.partial.toolName) : 'Tool'} trailing={<LiveDot />} live>
          <Pre text={props.partial?.text ?? ''} />
        </Disclosure>
      </Show>
    </>
  )

  /** What the live work row says Claude is doing right now. */
  const activity = (items: Item[]) => {
    const p = props.partial
    if (p?.type === 'tool_use') return p.toolName ? toolLabel(p.toolName) : ''
    if (p?.type === 'thinking') return 'Thinking'
    const last = items.findLast((i) => i.kind === 'tool' || i.kind === 'thinking')
    if (last?.kind === 'tool') return `${toolLabel(last.name)} ${toolSummary(last.name, last.input, props.cwd)}`
    return last?.kind === 'thinking' ? 'Thinking' : ''
  }

  const WorkRow = (p: { work: Work }) => {
    const items = () => folded().groups.get(p.work) ?? []
    const live = () => props.running && folded().tail === p.work
    const steps = () => items().filter((i) => i.kind === 'tool').length
    return (
      <Disclosure
        label={live() ? 'Working' : steps() ? 'Worked' : 'Thought'}
        detail={live() ? activity(items()) : steps() ? plural(steps(), 'step') : ''}
        trailing={
          <Show when={live()}>
            <Show when={steps()}>
              <span class="shrink-0 text-xs text-fg-3 tabular-nums">{plural(steps(), 'step')}</span>
            </Show>
            <LiveDot />
          </Show>
        }
      >
        <div>
          <For each={items()}>{render}</For>
          <Show when={live()}>{partialWork()}</Show>
        </div>
      </Disclosure>
    )
  }

  // Block layout so vertical margins collapse: prose breathes, tool rows stack tightly.
  const render = (item: Row): JSX.Element => {
    switch (item.kind) {
      case 'work':
        return <WorkRow work={item} />
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
      case 'tool': {
        const child = props.children?.[item.id]
        if (child) return <ChildRun sessionId={child} name={item.name} result={view().results.get(item.id)} />
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
      }
      case 'result':
        return (
          <div class={`mt-4 text-xs tabular-nums ${item.ok ? 'text-fg-3' : 'text-danger'}`}>
            {item.ok ? '' : `Stopped: ${item.error} · `}
            {duration(item.seconds)}
            {item.tokens ? ` · ${compact(item.tokens.input)} in · ${compact(item.tokens.output)} out` : ''}
            <Show when={item.endedAt}>{(at) => <Idle from={at()} until={view().idleUntil.get(item)} />}</Show>
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
      <For each={rows()}>{render}</For>
      <Show
        when={detail() === 'full'}
        fallback={
          // Nothing to fold yet: the turn has just started, or it's only thinking so far.
          <Show when={props.running && !folded().tail && props.partial?.type !== 'text'}>
            <WorkingLine detail={activity([])} />
          </Show>
        }
      >
        {partialWork()}
      </Show>
      <Show when={props.partial?.type === 'text' && props.partial.text}>
        <div class="my-4">
          <Markdown text={props.partial?.text ?? ''} />
        </div>
      </Show>
      <Show when={detail() === 'full' && props.working && !props.partial}>
        <WorkingLine />
      </Show>
    </div>
  )
}

/**
 * A tool call that runs another chat and waits on it, e.g. a merge in the
 * main checkout: that chat's transcript, nested. Its permission prompts show
 * with the parent's, by the composer.
 */
function ChildRun(props: { sessionId: string; name: string; result?: ToolResult }) {
  const child = useContext(ChildChats)
  const state = () => child(props.sessionId)
  const live = () => !!state()?.running
  const steps = () => state()?.messages.filter((m) => m.type === 'assistant' && !m.parent_tool_use_id && hasToolUse(m)).length ?? 0
  return (
    <Disclosure
      label={toolLabel(props.name)}
      detail={state()?.permissions.length ? 'Waiting for you' : live() ? 'Working' : ''}
      trailing={
        <>
          <Show when={steps()}>
            <span class="shrink-0 text-xs text-fg-3 tabular-nums">{plural(steps(), 'step')}</span>
          </Show>
          <Show when={live()}>
            <LiveDot />
          </Show>
          <Show when={props.result?.isError}>
            <span class="shrink-0 text-xs text-danger">Failed</span>
          </Show>
        </>
      }
      live={live()}
    >
      <div class="border-l border-line pl-4">
        <Show when={state()?.loaded && state()} fallback={<p class="py-1 text-xs text-fg-3">Loading…</p>}>
          {(s) => (
            <Transcript
              messages={s().messages}
              partial={s().partial}
              bashOutput={s().bashOutput}
              running={s().running}
              working={s().running && s().permissions.length === 0}
              cwd={s().cwd}
            />
          )}
        </Show>
      </div>
      <Show when={props.result?.isError && props.result}>{(r) => <Pre text={resultText(r().content)} class="text-danger" />}</Show>
      <a
        href={`/s/${props.sessionId}`}
        onClick={(e) => {
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
          e.preventDefault()
          history.pushState(null, '', `/s/${props.sessionId}`)
          dispatchEvent(new PopStateEvent('popstate'))
        }}
        class="inline-block text-xs text-fg-3 transition-colors hover:text-fg-2"
      >
        Open as a chat
      </a>
    </Disclosure>
  )
}

const hasToolUse = (m: WireMessage) => ((m.message as { content?: Block[] })?.content ?? []).some((b) => b.type === 'tool_use')

function WorkingLine(props: { detail?: string }) {
  return (
    <div class="mt-4 flex h-6 items-center gap-2 text-[13px] text-fg-3">
      <LiveDot /> Working
      <Show when={props.detail}>
        <span class="min-w-0 truncate font-mono text-xs">{props.detail}</span>
      </Show>
    </div>
  )
}

const badge = 'inline-flex max-w-[80%] items-center gap-2 rounded-full border border-line px-3 py-1 text-[13px]'

/** A card as a pill linking to it; `prefix` goes before its number, e.g. "On card". */
export function CardBadge(props: { card: { id: number; title: string; status: CardStatus }; prefix?: string }) {
  return (
    <a
      href={`/c/${props.card.id}`}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
        e.preventDefault()
        // App routes on popstate, so this navigates without a reload.
        history.pushState(null, '', `/c/${props.card.id}`)
        dispatchEvent(new PopStateEvent('popstate'))
      }}
      class={`${badge} text-fg-2 transition-colors hover:bg-surface hover:text-fg`}
    >
      <Columns3 class="size-3.5 shrink-0 text-fg-3" />
      <span class="min-w-0 truncate">
        <span class="text-fg-3">
          {props.prefix ? `${props.prefix} ` : ''}#{props.card.id}
        </span>{' '}
        {props.card.title}
      </span>
      <span class="shrink-0 text-xs text-fg-3">{STATUS_LABELS[props.card.status]}</span>
    </a>
  )
}

/** The card Claude was told about with this message, as a badge on the user's side linking to it. */
function CardContextBadge(props: { context: CardContext }) {
  return (
    <div class="-mt-2 mb-4 flex justify-end">
      <Show when={props.context.card} fallback={<span class={`${badge} text-fg-3`}><Columns3 class="size-3.5" />No longer on a card</span>}>
        {(card) => <CardBadge card={card()} />}
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

/** Ticks once a minute for every <Idle> on the page. */
const [now, setNow] = createSignal(Date.now())
setInterval(() => setNow(Date.now()), 60_000)

/** How long the chat sat idle after a turn: until the next prompt, or until now. */
function Idle(props: { from: number; until?: number }) {
  const label = () => {
    const minutes = Math.floor(((props.until ?? now()) - props.from) / 60_000)
    if (minutes < 1) return props.until ? '' : ' · just now'
    if (minutes < 60) return ` · ${minutes}m idle`
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return ` · ${hours}h idle`
    return ` · ${Math.floor(hours / 24)}d idle`
  }
  return <span title={new Date(props.from).toLocaleString()}>{label()}</span>
}
