import { parseCardContext, type CardContext } from '../../shared/cardContext.ts'
import { splitMoveNote, splitSideNote, type Move } from '../../shared/forkNote.ts'
import { unwrapPaste } from '../../shared/pastes.ts'
import { sentToSubagentBy } from '../../shared/toSubagent.ts'
import type { ImageAttachment, WireMessage } from '../../shared/protocol.ts'
import type { ShownImage } from '../images.ts'
import type { Task } from '../tasks.ts'
import type { ToolContext, ToolResult } from '../components/ToolCard.tsx'

/*
 * What a transcript's raw SDK messages say, as plain data: the items each message shows as, the index of a
 * whole chat (groups per subagent, tool calls and results, tasks), and the view of one conversation, with what
 * goes with each prompt and how each turn ended. No rendering here.
 */

export type Block = { type: string; text?: string; thinking?: string; id?: string; name?: string; input?: Record<string, unknown> }
export type ContentBlock = Block & { tool_use_id?: string; content?: unknown; is_error?: boolean; source?: { type: string; media_type: string; data?: string; url?: string } }

export type Item =
  /** `to`: the subagent it went to, for one the user sent a subagent through the chat. */
  | { kind: 'user'; text: string; pastes?: string[]; images?: ShownImage[]; to?: string }
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
export type Chip =
  | { type: 'skill'; text: string }
  | { type: 'instructions'; files: { path: string; type?: string; content: string }[] }
  | { type: 'hook'; hook?: string; text: string }
  | { type: 'hook_error'; hook?: string; command?: string; error: string }

/** A stretch of Claude's work folded into one row, in result-only mode. */
export type Work = { kind: 'work' }
export type Row = Item | Work

/**
 * Items per message, cached by message identity so <For> keeps existing rows
 * (and their open/closed state) when new messages arrive.
 */
const itemCache = new WeakMap<WireMessage, Item[]>()

export function itemsFor(m: WireMessage): Item[] {
  let items = itemCache.get(m)
  if (!items) itemCache.set(m, (items = messageItems(m)))
  return items
}

export function messageItems(m: WireMessage): Item[] {
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
    const relayed = sentToSubagentBy(raw)
    if (relayed) return [{ kind: 'user', text: relayed.text, to: relayed.description }]
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
    // Badger's own: the card, where a fork moved to, and that a side chat is one, which its panel says already.
    const { move, rest } = splitMoveNote(splitSideNote(String(m.text ?? '')).rest)
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
export function plainText(m: WireMessage): string {
  const content = (m.message as { content?: unknown })?.content
  if (typeof content === 'string') return content
  return Array.isArray(content) ? (content as ContentBlock[]).map((b) => (b.type === 'text' ? (b.text ?? '') : '')).join('\n') : ''
}

/** What a built-in command printed, from the tags Claude Code wraps it in; undefined for any other text. */
export function commandOutput(text: string): string | undefined {
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
  /** Subagents' Agent calls, by agent id. */
  agents: Map<string, string>
}

/** Adds context about a call to the index's. */
export function collectContext(m: WireMessage, context: Map<string, ToolContext>) {
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


/** Turn one conversation's raw SDK messages into renderable items. */
export function buildView(messages: WireMessage[], nested: boolean) {
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
  /** Each prompt's message, by which it's referred to from outside, e.g. by a panel showing one of its attachments. */
  const promptIds = new Map<Item, string>()
  for (const m of messages) {
    const user = itemsFor(m).find((i) => i.kind === 'user')
    if (user) turnPrompt = user
    if (user && m.uuid) promptIds.set(user, m.uuid)
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
    .filter((m) => !retracted.has(m.uuid) && !(nested && isNoise(m, messages)))
    .flatMap(itemsFor)
    .filter((i) => !attached.has(i))
  items = tidyCompactions(items)
  // A subagent's prompt is shown with the call that started it, so it goes from its first message; ones sent to it later stay.
  const prompt = nested && messages[0]?.type === 'user' ? itemsFor(messages[0]).find((i) => i.kind === 'user') : undefined
  return { items: prompt ? items.filter((i) => i !== prompt) : items, idleUntil, extras, promptIds, forkAt, interrupted, shownError, answeredBy, summaries }
}

/**
 * In a subagent's conversation, something that reads as a message to it but isn't: only its prompt and what's sent
 * to it are. The rest is Claude Code talking to it, e.g. a background task's notification, which neither the SDK's
 * stream nor its reader of subagents' transcripts marks as meta.
 */
const isNoise = (m: WireMessage, messages: WireMessage[]) =>
  m.type === 'user' && m !== messages[0] && sentToSubagent(m) === undefined && itemsFor(m).some((i) => i.kind === 'user')

/** What went in with a prompt besides what the user typed. */
export interface PromptExtras {
  card?: CardContext
  move?: Move
  chips: Chip[]
}

/** CLAUDE.md files loaded for one prompt make one chip, however many times they came in. */
export function addChip(chips: Chip[], chip: Chip) {
  const files = chip.type === 'instructions' && chips.find((c) => c.type === 'instructions')
  if (files && chip.type === 'instructions') files.files.push(...chip.files.filter((f) => !files.files.some((g) => g.path === f.path)))
  else if (!chips.some((c) => JSON.stringify(c) === JSON.stringify(chip))) chips.push(chip)
}

/**
 * After a reload, a /compact the user typed comes after the compaction it
 * started (Claude Code saves it once it's done), and its "Compacted" output
 * says what the divider does. The command goes first, as it was sent; the output goes.
 */
export function tidyCompactions(items: Item[]): Item[] {
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
export function foldWork(items: Item[]) {
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


export function collectResults(m: WireMessage, results: Map<string, ToolResult>) {
  const content = (m.message as { content?: unknown })?.content
  if (!Array.isArray(content)) return
  const blocks = (content as ContentBlock[]).filter((b) => b.type === 'tool_result' && b.tool_use_id)
  // The structured result belongs to the message as a whole, so it's only unambiguous with one result in it.
  const structured = blocks.length === 1 ? m.tool_use_result : undefined
  for (const b of blocks) results.set(b.tool_use_id!, { content: b.content, isError: !!b.is_error, structured })
}

/** A message Claude sent a subagent while it worked, without the framing Claude Code wraps it in. Claude Code marks these meta. */
export function sentToSubagent(m: WireMessage): string | undefined {
  const sent = plainText(m).match(/^The coordinator sent a message while you were working:\n([\s\S]*?)(?:\n+Address this before completing your current task\.)?$/)
  return sent?.[1].trim() || undefined
}

/** What the user typed, and the big pastes and images sent with it as attachments. */
export function userText(m: WireMessage): { text: string; pastes: string[]; images: ShownImage[] } {
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

/** How full the context was at Claude's last reply, from that call's usage. */
export function lastContext(messages: WireMessage[]): number | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.type !== 'assistant' || m.parent_tool_use_id) continue
    const tokens = turnTokens((m.message as { usage?: unknown })?.usage)
    if (tokens?.input) return tokens.input
  }
  return undefined
}

/** Where to fork to send a refused prompt again, edited: Claude's last answer before it. None for the chat's first prompt. */
export function retryOf(messages: WireMessage[], prompt?: string): { at: string; text: string } | undefined {
  const i = prompt ? messages.findIndex((m) => m.uuid === prompt) : -1
  if (i < 0) return undefined
  const at = messages.slice(0, i).findLast((m) => m.type === 'assistant' && !m.parent_tool_use_id && m.uuid)?.uuid
  return at ? { at, text: userText(messages[i]).text } : undefined
}

/** Why a turn stopped, from its result's subtype. */
export function stopReason(error?: string): string {
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
export function modelName(id?: string): string | undefined {
  const m = id?.match(/^claude-([a-z]+)-(\d+)-(\d+)(?:-\d{8})?/)
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}.${m[3]}` : id
}

/** What to call a subagent: its type, unless it's the general one. */
export function agentLabel(input: Record<string, unknown>): string {
  const type = typeof input.subagent_type === 'string' ? input.subagent_type : ''
  return type && type !== 'general-purpose' ? type : 'Agent'
}


/** The agent id in an Agent call's result, which Claude Code adds for SendMessage. */
export function agentIdIn(content: unknown): string | undefined {
  const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map((b) => (b?.type === 'text' ? b.text : '')).join('\n') : ''
  // The last: Claude Code adds it after the report, which could mention one too.
  return [...text.matchAll(/\bagentId: ([\w-]+)/g)].at(-1)?.[1]
}

/** A foreground agent's report as Claude received it, without the framing around it. */
export function handBack(text: string): string {
  const marker = 'The report follows:\n'
  const at = text.indexOf(marker)
  const report = at < 0 ? text : text.slice(at + marker.length).replace(/^ {2}/gm, '')
  return report.replace(/\nagentId: [\s\S]*$/, '').trim()
}

export const hasToolUse = (m: WireMessage) => ((m.message as { content?: Block[] })?.content ?? []).some((b) => b.type === 'tool_use')

type Usage = { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }

/** Tokens for one turn, cached input included. Main agent only; subagents aren't counted. */
export function turnTokens(usage: unknown): { input: number; output: number } | undefined {
  const u = usage as Usage | undefined
  if (!u || typeof u.output_tokens !== 'number') return undefined
  return {
    input: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
    output: u.output_tokens,
  }
}


/** 42s, 5m 3s, 1h 12m. */
export function duration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  return h ? `${h}h ${m}m` : `${m}m ${seconds % 60}s`
}

