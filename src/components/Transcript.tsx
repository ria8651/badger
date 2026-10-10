import { For, Show, createContext, createMemo, createSignal, onCleanup, useContext, type Accessor, type JSX } from 'solid-js'
import { unwrap } from 'solid-js/store'
import { Columns3 } from 'lucide-solid'
import { parseCardContext, type CardContext } from '../../shared/cardContext.ts'
import { unwrapPaste } from '../../shared/pastes.ts'
import type { CardStatus, ImageAttachment, WireMessage } from '../../shared/protocol.ts'
import { socket } from '../api.ts'
import { collectTasks, type Task } from '../tasks.ts'
import { ChildChats, type Partial } from '../useChat.ts'
import { STATUS_LABELS } from './Board.tsx'
import { Markdown } from './Markdown.tsx'
import { Disclosure, Pre, ToolCard, resultText, toolLabel, toolSummary, type ToolResult } from './ToolCard.tsx'
import { Attachments } from './Attachments.tsx'
import { LiveDot, compact, plural } from './ui.tsx'

type Block = { type: string; text?: string; thinking?: string; id?: string; name?: string; input?: Record<string, unknown> }
type ContentBlock = Block & { tool_use_id?: string; content?: unknown; is_error?: boolean; source?: { type: string; media_type: string; data: string } }

type Item =
  | { kind: 'user'; text: string; pastes?: string[]; images?: ImageAttachment[] }
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
  if (m.type === 'user') {
    const sent = sentToSubagent(m)
    if (sent) return [{ kind: 'user', text: sent }]
    if (m.isMeta || m.isSynthetic) return []
    const { text, pastes, images } = userText(m)
    return text || pastes.length || images.length ? [{ kind: 'user', text, pastes, images }] : []
  }
  if (m.type === 'assistant') {
    const content = ((m.message as { content?: Block[] })?.content ?? []) as Block[]
    const items: Item[] = []
    for (const b of content) {
      if (b.type === 'text' && b.text?.trim()) items.push({ kind: 'text', text: b.text })
      else if (b.type === 'thinking' && b.thinking?.trim()) items.push({ kind: 'thinking', text: b.thinking })
      // How a subagent hands its report back: that's its reply, not a step.
      else if (b.type === 'tool_use' && b.name === 'SubagentHandback') items.push({ kind: 'text', text: String(b.input?.message ?? '') })
      else if (b.type === 'tool_use' && b.id) items.push({ kind: 'tool', id: b.id, name: b.name ?? '?', input: b.input ?? {} })
    }
    return items
  }
  if (m.type === 'result') {
    const ok = m.subtype === 'success' && !m.is_error
    // A background task's notification can start a turn Claude has nothing to say in.
    if (ok && m.num_turns === 0) return []
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

/** What a whole chat's messages say, shared by its transcript, the subagent transcripts nested in it and its task tray. */
export interface Index {
  sessionId?: string
  /** Messages by the tool call of the subagent they belong to; the chat's own are under ''. */
  groups: Map<string, WireMessage[]>
  /** Tool results by tool_use_id. */
  results: Map<string, ToolResult>
  /** Subagents and other tasks by the tool_use_id that started them. */
  tasks: Map<string, Task>
  /** Each tool call's parent: the subagent call it was made in, or '' for the chat's own. */
  parents: Map<string, string>
}

/** Whether a tool call was made inside the subagent started by `ancestor`, at any depth. */
export function within(index: Index, id: string, ancestor: string): boolean {
  for (let p = index.parents.get(id); p; p = index.parents.get(p)) if (p === ancestor) return true
  return false
}

export function buildIndex(messages: WireMessage[], sessionId?: string): Index {
  const groups = new Map<string, WireMessage[]>()
  const results = new Map<string, ToolResult>()
  const parents = new Map<string, string>()
  for (const m of messages) {
    const parent = (m.parent_tool_use_id as string | null | undefined) ?? ''
    let group = groups.get(parent)
    if (!group) groups.set(parent, (group = []))
    group.push(m)
    if (m.type === 'user') collectResults(m, results)
    if (m.type === 'assistant') for (const b of ((m.message as { content?: Block[] })?.content ?? []) as Block[]) if (b.type === 'tool_use' && b.id) parents.set(b.id, parent)
  }
  return { sessionId, groups, results, tasks: collectTasks(messages), parents }
}

const TranscriptIndex = createContext<Accessor<Index>>()
const useIndex = () => useContext(TranscriptIndex)!
const NONE: WireMessage[] = []

/** Turn one conversation's raw SDK messages into renderable items. */
function buildView(messages: WireMessage[], nested: boolean) {
  // When the user next spoke after each turn; turns without one are idle until now.
  const idleUntil = new Map<Item, number>()
  let lastResult: Item | undefined
  for (const m of messages) {
    const items = itemsFor(m)
    if (m.type === 'result') lastResult = items[0]
    else if (lastResult && items[0]?.kind === 'user' && m.timestamp) {
      idleUntil.set(lastResult, Date.parse(String(m.timestamp)))
      lastResult = undefined
    }
  }
  // Card context goes in with the prompt it was injected for, so it's shown as one of its attachments.
  const cards = new Map<Item, CardContext>()
  const attached = new Set<Item>()
  let lastUser: Item | undefined
  for (const m of messages) {
    const items = itemsFor(m)
    if (m.type === 'hook_context') {
      if (lastUser && items[0]?.kind === 'card') {
        cards.set(lastUser, items[0].context)
        attached.add(items[0])
      }
    } else if (m.type === 'user' || m.type === 'assistant' || m.type === 'result') lastUser = items.find((i) => i.kind === 'user')
  }
  const items = messages.flatMap(itemsFor).filter((i) => !attached.has(i))
  // A subagent's prompt is shown with the call that started it; only messages sent to it later stay.
  const prompt = nested ? items.find((i) => i.kind === 'user') : undefined
  return { items: prompt ? items.filter((i) => i !== prompt) : items, idleUntil, cards }
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


function collectResults(m: WireMessage, results: Map<string, ToolResult>) {
  const content = (m.message as { content?: unknown })?.content
  if (!Array.isArray(content)) return
  const blocks = (content as ContentBlock[]).filter((b) => b.type === 'tool_result' && b.tool_use_id)
  // The structured result belongs to the message as a whole, so it's only unambiguous with one result in it.
  const structured = blocks.length === 1 ? m.tool_use_result : undefined
  for (const b of blocks) results.set(b.tool_use_id!, { content: b.content, isError: !!b.is_error, structured })
}

/** A message Claude sent a subagent while it worked, without the framing Claude Code wraps it in. Claude Code marks these meta. */
function sentToSubagent(m: WireMessage): string | undefined {
  const content = (m.message as { content?: unknown })?.content
  if (typeof content !== 'string') return
  const sent = content.match(/^The coordinator sent a message while you were working:\n([\s\S]*?)(?:\n+Address this before completing your current task\.)?$/)
  return sent?.[1].trim() || undefined
}

/** What the user typed, and the big pastes and images sent with it as attachments. */
function userText(m: WireMessage): { text: string; pastes: string[]; images: ImageAttachment[] } {
  const content = (m.message as { content?: unknown })?.content
  const all = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? (content as ContentBlock[]) : []
  const blocks = all.filter((b) => b.type === 'text').map((b) => b.text ?? '')
  const images = all.flatMap((b) =>
    b.type === 'image' && b.source?.type === 'base64' ? [{ mediaType: b.source.media_type, data: b.source.data } as ImageAttachment] : [],
  )
  const pastes: string[] = []
  const typed: string[] = []
  for (const b of blocks) {
    const paste = unwrapPaste(b)
    if (paste !== undefined) pastes.push(paste)
    else typed.push(b)
  }
  const raw = typed.join('\n')
  const command = raw.match(/<command-name>(.*?)<\/command-name>/)
  if (command) return { text: command[1], pastes, images }
  // Harness-injected content (system reminders, command output) is wrapped in tags.
  if (raw.trimStart().startsWith('<')) return { text: '', pastes, images }
  return { text: raw, pastes, images }
}

type TranscriptProps = {
  messages: WireMessage[]
  partial: Partial | null
  bashOutput: Record<string, string>
  running: boolean
  /** Running and not stopped on a permission prompt. */
  working: boolean
  cwd?: string
  /** Chats started from tool calls, by tool_use_id; those calls show the child's transcript. */
  children?: Record<string, string>
}

/** Index a chat's messages. Tracks the array and its length, then walks the raw objects so the cache keys are stable. */
export function createIndex(messages: () => WireMessage[], sessionId?: () => string | undefined): Accessor<Index> {
  return createMemo(() => {
    void messages().length
    return buildIndex(unwrap(messages()), sessionId?.())
  })
}

export function Transcript(props: TranscriptProps & { sessionId?: string; index?: Accessor<Index> }) {
  const index = props.index ?? createIndex(() => props.messages, () => props.sessionId)
  return (
    <TranscriptIndex.Provider value={index}>
      <Messages {...props} messages={index().groups.get('') ?? NONE} />
    </TranscriptIndex.Provider>
  )
}

/** One conversation: the chat's own, or a subagent's nested in the call that started it. */
function Messages(props: TranscriptProps & { nested?: boolean }) {
  const index = useIndex()
  const view = createMemo(() => buildView(props.messages, !!props.nested))
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
        holds={(id) => items().some((i) => i.kind === 'tool' && (i.id === id || within(index(), id, i.id)))}
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
        return <UserMessage text={item.text} pastes={item.pastes} images={item.images} card={view().cards.get(item)} />
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
        if (child) return <ChildRun sessionId={child} name={item.name} result={index().results.get(item.id)} />
        if (item.name === 'Agent' || item.name === 'Task') {
          return <AgentRun id={item.id} input={item.input} bashOutput={props.bashOutput} running={props.running} cwd={props.cwd} />
        }
        return (
          <ToolCard
            id={item.id}
            name={item.name}
            input={item.input}
            result={index().results.get(item.id)}
            liveOutput={props.bashOutput[item.id]}
            running={props.running}
            cwd={props.cwd}
            task={index().tasks.get(item.id)}
            onBackground={!props.nested && item.name === 'Bash' && index().sessionId ? () => runInBackground(index().sessionId!, item.id) : undefined}
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
      id={props.sessionId}
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
      <Show when={state()?.loaded && state()} fallback={<p class="py-1 text-xs text-fg-3">Loading…</p>}>
        {(s) => (
          <Transcript
            sessionId={props.sessionId}
            messages={s().messages}
            partial={s().partial}
            bashOutput={s().bashOutput}
            running={s().running}
            working={s().running && s().permissions.length === 0}
            cwd={s().cwd}
          />
        )}
      </Show>
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

/**
 * A subagent Claude Code started with the Agent tool: its own work nested in
 * the call, then its report. One in the background keeps running after the
 * call returns, until its task says it's done.
 */
function AgentRun(props: { id: string; input: Record<string, unknown>; bashOutput: Record<string, string>; running: boolean; cwd?: string }) {
  const index = useIndex()
  const messages = () => index().groups.get(props.id) ?? NONE
  const items = createMemo(() => buildView(messages(), true).items)
  const task = () => index().tasks.get(props.id)
  const result = () => index().results.get(props.id)
  const structured = () => result()?.structured as { status?: string; content?: Block[] } | undefined
  const launched = () => structured()?.status === 'async_launched' || resultText(result()?.content).startsWith('Async agent launched')
  const background = () => task()?.background ?? launched()
  const running = () => {
    const t = task()
    return t ? t.status === 'running' : !result() && props.running
  }
  const status = () => task()?.status ?? (result()?.isError ? 'failed' : undefined)
  const steps = () => Math.max(items().filter((i) => i.kind === 'tool').length, task()?.toolUses ?? 0)
  const prompt = () => (typeof props.input.prompt === 'string' ? props.input.prompt : '')

  /** The report, when its own transcript doesn't already end with it (live, a foreground agent's last message isn't sent). */
  const report = () => {
    if (running() || items().at(-1)?.kind === 'text') return undefined
    const text = (structured()?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n')
    if (text) return text
    if (task()?.summary) return task()!.summary
    if (result() && !launched()) return handBack(resultText(result()!.content))
  }

  const stop = () => {
    const sessionId = index().sessionId
    const t = task()
    if (sessionId && t) socket.send({ type: 'stop_task', sessionId, taskId: t.id })
  }

  return (
    <Disclosure
      id={props.id}
      label={agentLabel(props.input)}
      holds={(id) => within(index(), id, props.id)}
      detail={String(props.input.description ?? '')}
      trailing={
        <>
          <Show when={running() && background()}>
            <span class="shrink-0 text-xs text-fg-3">In background</span>
          </Show>
          <Show when={steps()}>
            <span class="shrink-0 text-xs text-fg-3 tabular-nums">
              {plural(steps(), 'step')}
              {!running() && task()?.tokens ? ` · ${compact(task()!.tokens!)} tokens` : ''}
            </span>
          </Show>
          <Show when={running()}>
            <LiveDot />
          </Show>
          <Show when={!running() && status() === 'failed'}>
            <span class="shrink-0 text-xs text-danger">Failed</span>
          </Show>
          <Show when={!running() && status() === 'stopped'}>
            <span class="shrink-0 text-xs text-fg-3">Stopped</span>
          </Show>
        </>
      }
      // One in the background can run for a long while alongside everything else, so it stays folded.
      live={running() && !background()}
      peek={running() && task()?.activity && <p class="truncate text-xs text-fg-3">{task()!.activity}</p>}
    >
      <Show when={prompt()}>{(p) => <Markdown text={p()} />}</Show>
      <Show when={items().length || report()}>
        <div>
          <Messages messages={messages()} nested partial={null} bashOutput={props.bashOutput} running={running()} working={running()} cwd={props.cwd} />
          <Show when={report()}>
            {(r) => (
              <div class="my-4">
                <Markdown text={r()} />
              </div>
            )}
          </Show>
        </div>
      </Show>
      <Show when={running() && task() && index().sessionId}>
        <div class="flex gap-4">
          <Show when={!background()}>
            <button onClick={() => runInBackground(index().sessionId!, props.id)} class="text-xs text-fg-3 transition-colors hover:text-fg-2">
              Run in background
            </button>
          </Show>
          <button onClick={stop} class="text-xs text-fg-3 transition-colors hover:text-fg-2">
            Stop agent
          </button>
        </div>
      </Show>
    </Disclosure>
  )
}

/** What to call a subagent: its type, unless it's the general one. */
export function agentLabel(input: Record<string, unknown>): string {
  const type = typeof input.subagent_type === 'string' ? input.subagent_type : ''
  return type && type !== 'general-purpose' ? type : 'Agent'
}

/** Stop waiting on a running subagent or command, leaving it to finish in the background; without an id, every one. */
export function runInBackground(sessionId: string, toolUseId?: string): void {
  socket.send({ type: 'background_task', sessionId, toolUseId })
}

/** A foreground agent's report as Claude received it, without the framing around it. */
function handBack(text: string): string {
  const marker = 'The report follows:\n'
  const at = text.indexOf(marker)
  const report = at < 0 ? text : text.slice(at + marker.length).replace(/^ {2}/gm, '')
  return report.replace(/\nagentId: [\s\S]*$/, '').trim()
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

/** A card as a pill linking to it. */
function CardBadge(props: { card: { id: number; title: string; status: CardStatus } }) {
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
        <span class="text-fg-3">#{props.card.id}</span>{' '}
        {props.card.title}
      </span>
      <span class="shrink-0 text-xs text-fg-3">{STATUS_LABELS[props.card.status]}</span>
    </a>
  )
}

/** Card context with no prompt to attach to, as a badge on the user's side linking to the card. */
function CardContextBadge(props: { context: CardContext }) {
  return (
    <div class="-mt-2 mb-4 flex justify-end">
      <Show when={props.context.card} fallback={<span class={`${badge} text-fg-3`}><Columns3 class="size-3.5" />No longer on a card</span>}>
        {(card) => <CardBadge card={card()} />}
      </Show>
    </div>
  )
}

/** A user's message; long ones (big pastes) are clamped with a fade until expanded. */
function UserMessage(props: { text: string; pastes?: string[]; images?: ImageAttachment[]; card?: CardContext }) {
  const [overflows, setOverflows] = createSignal(false)
  const [expanded, setExpanded] = createSignal(false)
  const clamped = () => overflows() && !expanded()
  return (
    <div class="mt-8 mb-4 flex justify-end first:mt-0">
      <div class="max-w-[80%] min-w-0 bg-surface rounded-2xl px-4 py-2.5 text-[15px] leading-relaxed">
        <Show when={props.pastes?.length || props.images?.length || props.card}>
          <Attachments pastes={props.pastes ?? []} images={props.images ?? []} card={props.card} class={props.text ? 'mb-2' : ''} />
        </Show>
        <Show when={props.text}>
          <div
            ref={(el) => {
              // Re-measured on resize: width changes rewrap the text, and hidden chats measure as 0.
              const observer = new ResizeObserver(() => !expanded() && setOverflows(el.scrollHeight > el.clientHeight))
              observer.observe(el)
              onCleanup(() => observer.disconnect())
            }}
            class="overflow-hidden whitespace-pre-wrap"
            style={{
              'max-height': expanded() ? undefined : '18rem',
              'mask-image': clamped() ? 'linear-gradient(to bottom, black 70%, transparent)' : undefined,
            }}
          >
            {props.text}
          </div>
          <Show when={overflows()}>
            <button class="mt-1 text-xs text-fg-3 hover:text-fg-2" onClick={() => setExpanded(!expanded())}>
              {expanded() ? 'Show less' : 'Show more'}
            </button>
          </Show>
        </Show>
      </div>
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
