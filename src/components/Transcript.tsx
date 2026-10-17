import { For, Show, createContext, createMemo, createSignal, onCleanup, useContext, type Accessor, type JSX } from 'solid-js'
import { unwrap } from 'solid-js/store'
import { BookOpen, ChevronRight, CircleAlert, Columns3, FileText, KeyRound, Repeat2, Scissors, Shield, ShieldAlert, Webhook } from '../icons'
import { parseCardContext, type CardContext } from '../../shared/cardContext.ts'
import { splitMoveNote, type Move } from '../../shared/forkNote.ts'
import { unwrapPaste } from '../../shared/pastes.ts'
import type { CardStatus, ImageAttachment, WireMessage } from '../../shared/protocol.ts'
import { socket } from '../api.ts'
import type { ShownImage } from '../images.ts'
import { collectTasks, type Task } from '../tasks.ts'
import { ChildChats, useChecking, type Partial } from '../useChat.ts'
import { STATUS_LABELS } from './Board.tsx'
import { Markdown } from './Markdown.tsx'
import { Disclosure, Pre, ToolBody, ToolCard, resultText, splitSkill, toolLabel, toolSummary, type ToolContext, type ToolResult } from './ToolCard.tsx'
import { Attachments, type ContextChip } from './Attachments.tsx'
import { basename } from '../folders.ts'
import { LiveDot, compact, plural } from './ui.tsx'

type Block = { type: string; text?: string; thinking?: string; id?: string; name?: string; input?: Record<string, unknown> }
type ContentBlock = Block & { tool_use_id?: string; content?: unknown; is_error?: boolean; source?: { type: string; media_type: string; data?: string; url?: string } }

type Item =
  | { kind: 'user'; text: string; pastes?: string[]; images?: ShownImage[] }
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool'; id: string; name: string; input: Record<string, unknown> }
  | { kind: 'result'; ok: boolean; seconds: number; tokens?: { input: number; output: number }; endedAt?: number; error?: string }
  | { kind: 'compact'; trigger?: string; preTokens?: number; postTokens?: number; seconds?: number }
  /** What Badger told Claude with a prompt: its card, and where a fork moved to. */
  | { kind: 'card'; context?: CardContext; move?: Move }
  /** Other context that went in with a prompt; `anchor` is the message it came after, if known. */
  | { kind: 'chip'; chip: Chip; anchor?: string }
  /** What a built-in command like /cost printed. */
  | { kind: 'output'; text: string }
  /** Something Claude Code did to the conversation, said where it happened. */
  | { kind: 'notice'; tone: 'cut' | 'safety' | 'compact_failed'; text: string }
  /** Another model answered because the chosen one refused. `refused` is the prompt it refused. */
  | { kind: 'fallback'; from?: string; to?: string; content: string; refused?: string }
  /** An error from the API (or Claude Code) in place of Claude's reply. */
  | { kind: 'api_error'; error: string; text: string }

/** Context that went in with a prompt, as its chip shows it. */
type Chip =
  | { type: 'skill'; text: string }
  | { type: 'instructions'; files: { path: string; type?: string; content: string }[] }
  | { type: 'hook'; hook?: string; text: string }
  | { type: 'hook_error'; hook?: string; command?: string; error: string }

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
    // Shown in the compaction's divider.
    if (m.isCompactSummary) return []
    const raw = plainText(m)
    if (raw.startsWith('Your response above was cut off')) return [{ kind: 'notice', tone: 'cut', text: 'Reply cut off; Claude was asked to carry on' }]
    if (raw.startsWith('Your response above was stopped by a safety classifier'))
      return [{ kind: 'notice', tone: 'safety', text: 'A safety check stopped the reply; Claude was asked to try another way' }]
    if (m.isMeta || m.isSynthetic) return []
    // The turn's last line says it was interrupted.
    if (raw.startsWith('[Request interrupted by user')) return []
    const output = commandOutput(raw)
    if (output !== undefined) return output ? [{ kind: 'output', text: output }] : []
    const { text, pastes, images } = userText(m)
    return text || pastes.length || images.length ? [{ kind: 'user', text, pastes, images }] : []
  }
  if (m.type === 'assistant') {
    const content = ((m.message as { content?: Block[] })?.content ?? []) as Block[]
    const said = content.flatMap((b) => (b.type === 'text' && b.text?.trim() ? [b.text] : [])).join('\n')
    if (m.isApiErrorMessage || m.error) return [{ kind: 'api_error', error: String(m.error ?? 'unknown'), text: said }]
    // Not Claude: a built-in command's output, live. (After a reload it's a local_command message.)
    if ((m.message as { model?: string })?.model === '<synthetic>') return said ? [{ kind: 'output', text: said }] : []
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
  // Context about a call shows with the call (see buildIndex).
  if (m.tool_use_id) return []
  const anchor = typeof m.anchor === 'string' ? m.anchor : undefined
  if (m.type === 'hook_context') {
    // Badger's own: the card, and where a fork moved to.
    const { move, rest } = splitMoveNote(String(m.text ?? ''))
    const context = rest ? parseCardContext(rest) : undefined
    if (context || move) return [{ kind: 'card', context, move }]
    return rest.trim() ? [{ kind: 'chip', anchor, chip: { type: 'hook', hook: str(m.hook), text: rest } }] : []
  }
  if (m.type === 'hook_error') return [{ kind: 'chip', anchor, chip: { type: 'hook_error', hook: str(m.hook), command: str(m.command), error: String(m.error ?? '') } }]
  if (m.type === 'instructions' && Array.isArray(m.files) && m.files.length) return [{ kind: 'chip', anchor, chip: { type: 'instructions', files: m.files } }]
  if (m.type === 'skill') return [{ kind: 'chip', anchor, chip: { type: 'skill', text: String(m.text ?? '') } }]
  if (m.type === 'compact_failed') return [{ kind: 'notice', tone: 'compact_failed', text: `Couldn’t compact the conversation${m.error ? `: ${m.error}` : ''}` }]
  if (m.type !== 'system') return []
  if (m.subtype === 'compact_boundary') {
    // Live, Claude Code says how big the context is after; the transcript doesn't keep that.
    const meta = (m.compact_metadata ?? {}) as { trigger?: string; pre_tokens?: number; post_tokens?: number; duration_ms?: number }
    const seconds = meta.duration_ms === undefined ? undefined : Math.round(meta.duration_ms / 1000)
    return [{ kind: 'compact', trigger: meta.trigger, preTokens: meta.pre_tokens, postTokens: meta.post_tokens, seconds }]
  }
  if (m.subtype === 'local_command') {
    const output = commandOutput(String(m.content ?? ''))
    return output ? [{ kind: 'output', text: output }] : []
  }
  if (m.subtype === 'model_refusal_fallback')
    return [{ kind: 'fallback', from: str(m.original_model), to: str(m.fallback_model), content: String(m.content ?? ''), refused: str(m.refused_user_message_uuid) }]
  return []
}

const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined)

/** A user message's text, its blocks joined. */
function plainText(m: WireMessage): string {
  const content = (m.message as { content?: unknown })?.content
  if (typeof content === 'string') return content
  return Array.isArray(content) ? (content as ContentBlock[]).map((b) => (b.type === 'text' ? (b.text ?? '') : '')).join('\n') : ''
}

/** What a built-in command printed, from the tags Claude Code wraps it in; undefined for any other text. */
function commandOutput(text: string): string | undefined {
  const m = text.trim().match(/^<local-command-(stdout|stderr)>([\s\S]*)<\/local-command-\1>$/)
  return m ? m[2].trim() : undefined
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
  /** Tool calls by tool_use_id. */
  uses: Map<string, { name: string; input: Record<string, unknown> }>
  /** What Claude Code added about calls, by tool_use_id: a Skill call's instructions, hooks' context and failures. */
  context: Map<string, ToolContext>
}

/** Adds context about a call to the index's. */
function collectContext(m: WireMessage, context: Map<string, ToolContext>) {
  const id = m.tool_use_id as string
  let c = context.get(id)
  if (!c) context.set(id, (c = { hooks: [], errors: [] }))
  if (m.type === 'skill') c.skill = String(m.text ?? '')
  else if (m.type === 'hook_context') c.hooks.push({ hook: str(m.hook), text: String(m.text ?? '') })
  else if (m.type === 'hook_error') c.errors.push({ hook: str(m.hook), command: str(m.command), error: String(m.error ?? '') })
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
  const uses: Index['uses'] = new Map()
  const context: Index['context'] = new Map()
  for (const m of messages) {
    if (typeof m.tool_use_id === 'string' && m.type !== 'system') {
      collectContext(m, context)
      continue
    }
    const parent = (m.parent_tool_use_id as string | null | undefined) ?? ''
    let group = groups.get(parent)
    if (!group) groups.set(parent, (group = []))
    group.push(m)
    if (m.type === 'user') collectResults(m, results)
    if (m.type !== 'assistant') continue
    for (const b of ((m.message as { content?: Block[] })?.content ?? []) as Block[]) {
      if (b.type !== 'tool_use' || !b.id) continue
      parents.set(b.id, parent)
      uses.set(b.id, { name: b.name ?? '?', input: b.input ?? {} })
    }
  }
  return { sessionId, groups, results, tasks: collectTasks(messages), parents, uses, context }
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
  // Context goes in with the prompt it was given with, so it's shown as one of its attachments: where it
  // says it came in, or else (Badger's own, live) right after the prompt.
  const extras = new Map<Item, PromptExtras>()
  const attached = new Set<Item>()
  const extrasOf = (prompt: Item) => {
    let e = extras.get(prompt)
    if (!e) extras.set(prompt, (e = { chips: [] }))
    return e
  }
  /** The prompt of the turn each message is in, by uuid. */
  const promptOf = new Map<string, Item>()
  let turnPrompt: Item | undefined
  for (const m of messages) {
    const user = itemsFor(m).find((i) => i.kind === 'user')
    if (user) turnPrompt = user
    if (m.uuid && turnPrompt) promptOf.set(m.uuid, turnPrompt)
  }
  let lastUser: Item | undefined
  // Each turn forks from its last answer: one rebuilt from the transcript says which, a live one follows it.
  const forkAt = new Map<Item, string>()
  let lastAnswer: string | undefined
  // How each turn ended: stopped by the user, on an error already shown, or answered by another model.
  const interrupted = new Set<Item>()
  const shownError = new Set<Item>()
  const answeredBy = new Map<Item, string>()
  let interrupt = false
  let errorShown = false
  let fallback: string | undefined
  // Each compaction's summary.
  const summaries = new Map<Item, string>()
  let compaction: Item | undefined
  for (const m of messages) {
    const items = itemsFor(m)
    const first = items[0]
    if (first?.kind === 'card' || first?.kind === 'chip') {
      const anchor = typeof m.anchor === 'string' ? m.anchor : undefined
      const prompt = (anchor && promptOf.get(anchor)) || lastUser
      if (prompt) {
        const e = extrasOf(prompt)
        if (first.kind === 'card') {
          e.card = first.context ?? e.card
          e.move = first.move ?? e.move
        } else addChip(e.chips, first.chip)
        attached.add(first)
      }
    } else if (m.type === 'user' || m.type === 'assistant' || m.type === 'result') lastUser = items.find((i) => i.kind === 'user')
    if (m.type === 'assistant' && m.uuid) lastAnswer = m.uuid
    if (m.type === 'user' && plainText(m).startsWith('[Request interrupted by user')) interrupt = true
    if (first?.kind === 'api_error') errorShown = true
    if (first?.kind === 'fallback') fallback = first.to
    if (first?.kind === 'compact') compaction = first
    if (compaction && m.isCompactSummary) {
      summaries.set(compaction, plainText(m))
      compaction = undefined
    }
    if (m.type === 'result' && first) {
      const at = typeof m.after_uuid === 'string' ? m.after_uuid : lastAnswer
      if (at) forkAt.set(first, at)
      if (interrupt) interrupted.add(first)
      if (errorShown) shownError.add(first)
      if (fallback) answeredBy.set(first, fallback)
      interrupt = errorShown = false
      fallback = undefined
    }
  }
  // A refused reply is withdrawn when another model answers instead.
  const retracted = new Set(messages.flatMap((m) => (m.subtype === 'model_refusal_fallback' && Array.isArray(m.retracted_message_uuids) ? m.retracted_message_uuids : [])))
  let items = messages
    .filter((m) => !retracted.has(m.uuid))
    .flatMap(itemsFor)
    .filter((i) => !attached.has(i))
  items = tidyCompactions(items)
  // A subagent's prompt is shown with the call that started it; only messages sent to it later stay.
  const prompt = nested ? items.find((i) => i.kind === 'user') : undefined
  return { items: prompt ? items.filter((i) => i !== prompt) : items, idleUntil, extras, forkAt, interrupted, shownError, answeredBy, summaries }
}

/** What went in with a prompt besides what the user typed. */
interface PromptExtras {
  card?: CardContext
  move?: Move
  chips: Chip[]
}

/** CLAUDE.md files loaded for one prompt make one chip, however many times they came in. */
function addChip(chips: Chip[], chip: Chip) {
  const files = chip.type === 'instructions' && chips.find((c) => c.type === 'instructions')
  if (files && chip.type === 'instructions') files.files.push(...chip.files.filter((f) => !files.files.some((g) => g.path === f.path)))
  else if (!chips.some((c) => JSON.stringify(c) === JSON.stringify(chip))) chips.push(chip)
}

/**
 * After a reload, a /compact the user typed comes after the compaction it
 * started (Claude Code saves it once it's done), and its "Compacted" output
 * says what the divider does. The command goes first, as it was sent; the output goes.
 */
function tidyCompactions(items: Item[]): Item[] {
  const out = items.filter((i, n) => !(i.kind === 'output' && /^Compacted\b/.test(i.text) && items.slice(0, n).some((j) => j.kind === 'compact')))
  for (let i = 0; i < out.length; i++) {
    const next = out[i + 1]
    if (out[i].kind === 'compact' && next?.kind === 'user' && /^\/compact\b/.test(next.text)) [out[i], out[i + 1]] = [next, out[i]]
  }
  return out
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
function userText(m: WireMessage): { text: string; pastes: string[]; images: ShownImage[] } {
  const content = (m.message as { content?: unknown })?.content
  const all = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? (content as ContentBlock[]) : []
  const blocks = all.filter((b) => b.type === 'text').map((b) => b.text ?? '')
  const images = all.flatMap((b): ShownImage[] => {
    if (b.type !== 'image') return []
    if (b.source?.type === 'url' && b.source.url) return [{ url: b.source.url }]
    return b.source?.type === 'base64' ? [{ mediaType: b.source.media_type, data: b.source.data } as ImageAttachment] : []
  })
  const pastes: string[] = []
  const typed: string[] = []
  for (const b of blocks) {
    const paste = unwrapPaste(b)
    if (paste !== undefined) pastes.push(paste)
    else typed.push(b)
  }
  const raw = typed.join('\n')
  const command = raw.match(/<command-name>(.*?)<\/command-name>/)
  if (command) {
    const args = raw.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1].trim()
    return { text: args ? `${command[1]} ${args}` : command[1], pastes, images }
  }
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
  /** Given, each turn offers to fork the chat from its end, the id of its last message. */
  onFork?: (at: string) => void
  /** When Claude Code started compacting the conversation, while it is. */
  compacting?: number
  /** Given, an expired login offers to log in again. */
  onLogin?: () => void
  /** Given, a prompt one model refused and another answered offers to fork from just before it, with its text to edit and send again. */
  onRetry?: (retry: { at: string; text: string }) => void
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
  const isChecking = useChecking()
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
    const checking = () => live() && !props.partial && items().some((i) => i.kind === 'tool' && isChecking(i.id))
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
            <Show when={checking()} fallback={<LiveDot />}>
              <span title="Auto mode is checking whether to allow this">
                <Shield class="size-3.5 shrink-0 animate-pulse text-fg-3" />
              </span>
            </Show>
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
          <UserMessage
            text={item.text}
            pastes={item.pastes}
            images={item.images}
            card={view().extras.get(item)?.card}
            move={view().extras.get(item)?.move}
            context={view().extras.get(item)?.chips.map(contextChip)}
          />
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
            context={index().context.get(item.id)}
            onBackground={!props.nested && item.name === 'Bash' && index().sessionId ? () => runInBackground(index().sessionId!, item.id) : undefined}
          />
        )
      }
      case 'result': {
        // Stopped by the user, or on an error already shown above, isn't news; any other way of stopping is.
        const quiet = () => item.ok || view().interrupted.has(item) || view().shownError.has(item)
        return (
          <div class={`mt-4 text-xs tabular-nums ${quiet() ? 'text-fg-3' : 'text-danger'}`}>
            {view().interrupted.has(item) ? 'Interrupted · ' : quiet() ? '' : `Stopped: ${stopReason(item.error)} · `}
            {duration(item.seconds)}
            {item.tokens ? ` · ${compact(item.tokens.input)} in · ${compact(item.tokens.output)} out` : ''}
            <Show when={view().answeredBy.get(item)}>{(model) => ` · ${modelName(model())}`}</Show>
            <Show when={item.endedAt}>{(at) => <Idle from={at()} until={view().idleUntil.get(item)} />}</Show>
            <Show when={!props.nested && props.onFork && view().forkAt.get(item)}>
              {(at) => (
                <>
                  {' · '}
                  <button
                    type="button"
                    title="Copy the chat up to here as a new one"
                    onClick={() => props.onFork!(at())}
                    class="-mx-1 rounded-sm px-1 py-0.5 transition-colors hover:bg-surface"
                  >
                    Fork
                  </button>
                </>
              )}
            </Show>
          </div>
        )
      }
      case 'compact':
        return <CompactDivider item={item} summary={view().summaries.get(item)} />
      case 'card':
        return (
          <Show when={item.context}>
            {(context) => <CardContextBadge context={context()} />}
          </Show>
        )
      case 'chip':
        // Only when there's no prompt to go with, e.g. a hook's context before the first.
        return (
          <div class="my-3">
            <Attachments pastes={[]} images={[]} context={[contextChip(item.chip)]} />
          </div>
        )
      case 'output':
        return (
          <div class="my-3 space-y-1.5">
            <div class="text-xs text-fg-3">Claude Code’s output (Claude sees it too)</div>
            <Pre text={item.text} />
          </div>
        )
      case 'notice':
        return (
          <Notice
            icon={item.tone === 'cut' ? Scissors : item.tone === 'safety' ? ShieldAlert : CircleAlert}
            text={item.text}
            danger={item.tone === 'compact_failed'}
          />
        )
      case 'fallback': {
        const retry = props.onRetry && !props.nested ? retryOf(props.messages, item.refused) : undefined
        return (
          <Notice
            icon={Repeat2}
            text={`${modelName(item.from) ?? 'The model'} declined; ${modelName(item.to) ?? 'another model'} answered instead`}
            action={retry ? { label: 'Edit and retry', run: () => props.onRetry!(retry) } : undefined}
          >
            <p class="whitespace-pre-wrap text-fg-3">{item.content}</p>
          </Notice>
        )
      }
      case 'api_error':
        return <ApiError item={item} onLogin={props.nested ? undefined : props.onLogin} />
    }
  }

  return (
    <div>
      <For each={rows()}>{render}</For>
      <Show
        when={detail() === 'full'}
        fallback={
          // Nothing to fold yet: the turn has just started, or it's only thinking so far.
          <Show when={props.running && !props.compacting && !folded().tail && props.partial?.type !== 'text'}>
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
      <Show when={props.compacting} fallback={<Show when={detail() === 'full' && props.working && !props.partial}><WorkingLine /></Show>}>
        {(since) => <CompactingLine since={since()} tokens={lastContext(props.messages)} />}
      </Show>
    </div>
  )
}

/** Compacting now: how much is going in, and for how long so far. Claude Code says nothing in between. */
function CompactingLine(props: { since: number; tokens?: number }) {
  const [now, setNow] = createSignal(Date.now())
  const timer = setInterval(() => setNow(Date.now()), 1000)
  onCleanup(() => clearInterval(timer))
  return (
    <div class="my-8 flex items-center gap-3 text-xs text-fg-3">
      <div class="h-px flex-1 bg-line" />
      <span class="flex items-center gap-2 tabular-nums">
        <LiveDot />
        Compacting{props.tokens ? ` ${compact(props.tokens)} tokens` : ''} · {duration(Math.max(0, Math.round((now() - props.since) / 1000)))}
      </span>
      <div class="h-px flex-1 bg-line" />
    </div>
  )
}

/** How full the context was at Claude's last reply, from that call's usage. */
function lastContext(messages: WireMessage[]): number | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.type !== 'assistant' || m.parent_tool_use_id) continue
    const tokens = turnTokens((m.message as { usage?: unknown })?.usage)
    if (tokens?.input) return tokens.input
  }
  return undefined
}

/**
 * Where the conversation was compacted: how and how much, opening to the
 * summary Claude carries on from in place of everything above.
 */
function CompactDivider(props: { item: Extract<Item, { kind: 'compact' }>; summary?: string }) {
  const [open, setOpen] = createSignal(false)
  const label = () => {
    const how = props.item.trigger === 'manual' ? 'Compacted with /compact' : props.item.trigger === 'auto' ? 'Compacted automatically' : 'Compacted'
    const size = props.item.preTokens ? `${compact(props.item.preTokens)}${props.item.postTokens ? ` → ${compact(props.item.postTokens)}` : ''} tokens` : ''
    return [how, size, props.item.seconds ? duration(props.item.seconds) : ''].filter(Boolean).join(' · ')
  }
  return (
    <div class="my-8">
      <button
        type="button"
        disabled={!props.summary}
        onClick={() => setOpen(!open())}
        class="flex w-full items-center gap-3 text-xs text-fg-3 enabled:hover:text-fg-2"
      >
        <div class="h-px flex-1 bg-line" />
        <span class="flex items-center gap-1 tabular-nums">
          {label()}
          <Show when={props.summary}>
            <ChevronRight class={`size-3.5 transition-transform ${open() ? 'rotate-90' : ''}`} />
          </Show>
        </span>
        <div class="h-px flex-1 bg-line" />
      </button>
      <Show when={open() && props.summary}>
        {(summary) => (
          <div class="mt-3 max-h-[32rem] overflow-auto rounded-lg border border-edge px-4 py-3 text-[13px] text-fg-2">
            <p class="mb-2 text-xs text-fg-3">What Claude carries on from, in place of the conversation above:</p>
            <Markdown text={summary()} />
          </div>
        )}
      </Show>
    </div>
  )
}

/** Something Claude Code did to the conversation: a quiet line where it happened, opening to its details if it has any. */
function Notice(props: { icon: typeof Scissors; text: string; danger?: boolean; action?: { label: string; run: () => void }; children?: JSX.Element }) {
  const [open, setOpen] = createSignal(false)
  return (
    <div class="my-3 text-xs">
      <div class={`flex items-center gap-1.5 ${props.danger ? 'text-danger' : 'text-fg-3'}`}>
        <props.icon class="size-3.5 shrink-0" />
        <Show when={props.children} fallback={<span>{props.text}</span>}>
          <button type="button" class="flex min-w-0 items-center gap-1 text-left hover:text-fg-2" onClick={() => setOpen(!open())}>
            {props.text}
            <ChevronRight class={`size-3.5 shrink-0 transition-transform ${open() ? 'rotate-90' : ''}`} />
          </button>
        </Show>
        <Show when={props.action}>
          {(action) => (
            <>
              <span>·</span>
              <button type="button" onClick={() => action().run()} class="-mx-1 shrink-0 rounded px-1 py-0.5 text-fg-2 transition-colors hover:bg-surface hover:text-fg">
                {action().label}
              </button>
            </>
          )}
        </Show>
      </div>
      <Show when={open()}>
        <div class="mt-2 pl-5">{props.children}</div>
      </Show>
    </div>
  )
}

/** An error in place of Claude's reply, said once, with the fix where Badger can do it. */
function ApiError(props: { item: Extract<Item, { kind: 'api_error' }>; onLogin?: () => void }) {
  const login = () => props.item.error === 'authentication_failed'
  return (
    <div class="my-4 flex items-start gap-2.5 rounded-lg border border-danger/30 bg-danger/5 px-3 py-2.5 text-[13px]">
      {login() ? <KeyRound class="mt-0.5 size-4 shrink-0 text-danger" /> : <CircleAlert class="mt-0.5 size-4 shrink-0 text-danger" />}
      <div class="min-w-0 flex-1">
        <div class="text-fg">{login() ? 'Claude Code’s login has expired' : props.item.text || 'Claude Code couldn’t reach Claude'}</div>
        <Show when={login()}>
          <div class="text-xs text-fg-3">Log in again, then send your message again.</div>
        </Show>
      </div>
      <Show when={login() && props.onLogin}>
        <button
          type="button"
          onClick={() => props.onLogin!()}
          class="shrink-0 rounded-md border border-edge px-2.5 py-1 text-xs text-fg-2 transition-colors hover:bg-surface hover:text-fg"
        >
          Log in in a terminal
        </button>
      </Show>
    </div>
  )
}

/** A prompt's context as a chip. */
function contextChip(chip: Chip): ContextChip {
  switch (chip.type) {
    case 'skill': {
      const { dir, body } = splitSkill(chip.text)
      return {
        icon: BookOpen,
        label: `${dir ? basename(dir) : 'Skill'} skill`,
        meta: `${compact(body.length)} chars`,
        body: () => (
          <>
            <Show when={dir}>
              <div class="mb-1.5 font-mono text-xs text-fg-3">{dir}</div>
            </Show>
            <Markdown text={body} />
          </>
        ),
      }
    }
    case 'instructions': {
      const names = [...new Set(chip.files.map((f) => (f.type === 'AutoMem' ? 'memory' : basename(f.path))))]
      return {
        icon: FileText,
        label: names.join(', '),
        meta: chip.files.length > 1 ? plural(chip.files.length, 'file') : undefined,
        body: () => (
          <For each={chip.files}>
            {(f) => (
              <div class="mb-3 last:mb-0">
                <div class="mb-1 font-mono text-xs text-fg-3">{f.path}</div>
                <Markdown text={f.content} />
              </div>
            )}
          </For>
        ),
      }
    }
    case 'hook':
      return { icon: Webhook, label: `${chip.hook ?? 'A'} hook`, body: () => <p class="whitespace-pre-wrap">{chip.text}</p> }
    case 'hook_error':
      return {
        icon: CircleAlert,
        label: `${chip.hook ?? 'A'} hook failed`,
        danger: true,
        body: () => (
          <p class="whitespace-pre-wrap">
            {chip.command ? <span class="font-mono text-xs">{chip.command}</span> : 'It'} failed
            {chip.error && chip.error !== 'No stderr output' ? `: ${chip.error}` : ''}. Claude carried on.
          </p>
        ),
      }
  }
}

/** Where to fork to send a refused prompt again, edited: Claude's last answer before it. None for the chat's first prompt. */
function retryOf(messages: WireMessage[], prompt?: string): { at: string; text: string } | undefined {
  const i = prompt ? messages.findIndex((m) => m.uuid === prompt) : -1
  if (i < 0) return undefined
  const at = messages.slice(0, i).findLast((m) => m.type === 'assistant' && !m.parent_tool_use_id && m.uuid)?.uuid
  return at ? { at, text: userText(messages[i]).text } : undefined
}

/** Why a turn stopped, from its result's subtype. */
function stopReason(error?: string): string {
  switch (error) {
    case 'error_max_turns':
      return 'hit the turn limit'
    case 'error_max_budget_usd':
      return 'hit the spending limit'
    case 'error_during_execution':
      return 'something went wrong'
    default:
      return error ?? 'something went wrong'
  }
}

/** "Opus 4.8" for claude-opus-4-8, and other ids as they are. */
function modelName(id?: string): string | undefined {
  const m = id?.match(/^claude-([a-z]+)-(\d+)-(\d+)(?:-\d{8})?/)
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}.${m[3]}` : id
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

/** How a subagent Claude Code started with the Agent tool is going, read from the chat's index. */
function agentState(props: { id: string; input: Record<string, unknown>; running: boolean }) {
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

  return { index, messages, items, task, background, running, status, steps, prompt, report, stop }
}

type Agent = ReturnType<typeof agentState>

/** A subagent's prompt, its own work and its report, with what can be done while it runs. */
function AgentBody(props: { id: string; agent: Agent; bashOutput: Record<string, string>; cwd?: string }) {
  const a = props.agent
  return (
    <>
      <Show when={a.prompt()}>{(p) => <Markdown text={p()} />}</Show>
      <Show when={a.items().length || a.report()}>
        <div>
          <Messages messages={a.messages()} nested partial={null} bashOutput={props.bashOutput} running={a.running()} working={a.running()} cwd={props.cwd} />
          <Show when={a.report()}>
            {(r) => (
              <div class="my-4">
                <Markdown text={r()} />
              </div>
            )}
          </Show>
        </div>
      </Show>
      <Show when={a.running() && a.task() && a.index().sessionId}>
        <div class="flex gap-4">
          <Show when={!a.background()}>
            <button onClick={() => runInBackground(a.index().sessionId!, props.id)} class="text-xs text-fg-3 transition-colors hover:text-fg-2">
              Run in background
            </button>
          </Show>
          <button onClick={a.stop} class="text-xs text-fg-3 transition-colors hover:text-fg-2">
            Stop agent
          </button>
        </div>
      </Show>
    </>
  )
}

/**
 * A subagent Claude Code started with the Agent tool: its own work nested in
 * the call, then its report. One in the background keeps running after the
 * call returns, until its task says it's done.
 */
function AgentRun(props: { id: string; input: Record<string, unknown>; bashOutput: Record<string, string>; running: boolean; cwd?: string }) {
  const a = agentState(props)
  return (
    <Disclosure
      id={props.id}
      label={agentLabel(props.input)}
      holds={(id) => within(a.index(), id, props.id)}
      detail={String(props.input.description ?? '')}
      trailing={
        <>
          <Show when={a.running() && a.background()}>
            <span class="shrink-0 text-xs text-fg-3">In background</span>
          </Show>
          <Show when={a.steps()}>
            <span class="shrink-0 text-xs text-fg-3 tabular-nums">
              {plural(a.steps(), 'step')}
              {!a.running() && a.task()?.tokens ? ` · ${compact(a.task()!.tokens!)} tokens` : ''}
            </span>
          </Show>
          <Show when={a.running()}>
            <LiveDot />
          </Show>
          <Show when={!a.running() && a.status() === 'failed'}>
            <span class="shrink-0 text-xs text-danger">Failed</span>
          </Show>
          <Show when={!a.running() && a.status() === 'stopped'}>
            <span class="shrink-0 text-xs text-fg-3">Stopped</span>
          </Show>
        </>
      }
      // One in the background can run for a long while alongside everything else, so it stays folded.
      live={a.running() && !a.background()}
      peek={a.running() && a.task()?.activity && <p class="truncate text-xs text-fg-3">{a.task()!.activity}</p>}
    >
      <AgentBody id={props.id} agent={a} bashOutput={props.bashOutput} cwd={props.cwd} />
    </Disclosure>
  )
}

/**
 * A subagent or background task in a panel of its own: everything its row in
 * the transcript holds, opened out, staying at the bottom as it grows unless
 * scrolled up.
 */
export function TaskPane(props: {
  id: string
  index: Accessor<Index>
  bashOutput: Record<string, string>
  running: boolean
  cwd?: string
  onShowInChat: () => void
  onReady: (focus: () => void) => void
}) {
  let scroller!: HTMLDivElement
  let pinned = true
  const use = () => props.index().uses.get(props.id)
  const isAgent = () => use()?.name === 'Agent' || use()?.name === 'Task'
  return (
    <TranscriptIndex.Provider value={props.index}>
      <div
        ref={(el) => {
          scroller = el
          props.onReady(() => el.focus({ preventScroll: true }))
        }}
        tabIndex={-1}
        onScroll={() => (pinned = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 8)}
        class="size-full overflow-y-auto outline-none [overflow-anchor:none]"
      >
        <div
          ref={(el) => {
            const observer = new ResizeObserver(() => pinned && (scroller.scrollTop = scroller.scrollHeight))
            observer.observe(el)
            onCleanup(() => observer.disconnect())
          }}
          class="space-y-2 px-5 pt-2 pb-6 text-[13px]"
        >
          <Show when={use()} fallback={<p class="text-xs text-fg-3">This task isn’t in the chat any more.</p>}>
            {(u) => (
              <>
                <div class="flex items-baseline gap-2">
                  <span class="min-w-0 flex-1 truncate font-mono text-xs text-fg-3">{toolSummary(u().name, u().input, props.cwd)}</span>
                  <button onClick={props.onShowInChat} class="shrink-0 text-xs text-fg-3 transition-colors hover:text-fg-2">
                    Show in chat
                  </button>
                </div>
                <Show
                  when={isAgent()}
                  fallback={
                    <ToolBody
                      id={props.id}
                      name={u().name}
                      input={u().input}
                      result={props.index().results.get(props.id)}
                      liveOutput={props.bashOutput[props.id]}
                      running={props.running}
                      cwd={props.cwd}
                      task={props.index().tasks.get(props.id)}
                      fill
                    />
                  }
                >
                  <AgentPane id={props.id} input={u().input} bashOutput={props.bashOutput} running={props.running} cwd={props.cwd} />
                </Show>
              </>
            )}
          </Show>
        </div>
      </div>
    </TranscriptIndex.Provider>
  )
}

function AgentPane(props: { id: string; input: Record<string, unknown>; bashOutput: Record<string, string>; running: boolean; cwd?: string }) {
  const a = agentState(props)
  return <AgentBody id={props.id} agent={a} bashOutput={props.bashOutput} cwd={props.cwd} />
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

/** Card context with no prompt to attach to, as a badge under the user's message linking to the card. */
function CardContextBadge(props: { context: CardContext }) {
  return (
    <div class="-mt-2 mb-4 -ml-3 flex justify-start">
      <Show when={props.context.card} fallback={<span class={`${badge} text-fg-3`}><Columns3 class="size-3.5" />No longer on a card</span>}>
        {(card) => <CardBadge card={card()} />}
      </Show>
    </div>
  )
}

/**
 * A user's message; long ones (big pastes) are clamped with a fade until expanded. Left-aligned, hanging
 * its padding into the margin so the text lines up with Claude's. Children go beside it, e.g. a queued one's buttons.
 */
export function UserMessage(props: {
  text: string
  pastes?: string[]
  images?: ShownImage[]
  card?: CardContext
  /** Where a fork moved to, as Claude was told with this message. */
  move?: Move
  /** Other context Claude was given with it. */
  context?: ContextChip[]
  /** Replaces the spacing it has in the transcript. */
  class?: string
  /** How tall it gets before it's clamped. */
  maxHeight?: string
  children?: JSX.Element
}) {
  const [overflows, setOverflows] = createSignal(false)
  const [expanded, setExpanded] = createSignal(false)
  const clamped = () => overflows() && !expanded()
  return (
    <div class={`flex items-center justify-start gap-1 ${props.class ?? 'mt-8 mb-4 first:mt-0'}`}>
      <div class="-ml-4 max-w-[80%] min-w-0 bg-surface rounded-2xl px-4 py-2.5 text-[15px] leading-relaxed">
        <Show when={props.pastes?.length || props.images?.length || props.card || props.move || props.context?.length}>
          <Attachments
            pastes={props.pastes ?? []}
            images={props.images ?? []}
            card={props.card}
            move={props.move}
            context={props.context}
            class={props.text ? 'mb-2' : ''}
          />
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
              'max-height': expanded() ? undefined : (props.maxHeight ?? '18rem'),
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
      {props.children}
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
