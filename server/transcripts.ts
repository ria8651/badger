import type { DatabaseSync } from 'node:sqlite'
import {
  foldSessionSummary,
  getSessionMessages,
  getSubagentMessages,
  listSessions,
  listSubagents,
  type SDKSessionInfo,
  type SessionKey,
  type SessionStore,
  type SessionStoreEntry,
  type SessionSummaryEntry,
} from '@anthropic-ai/claude-agent-sdk'
import type { WireMessage } from '../shared/protocol.ts'
import { IMAGE_LINE, IMAGE_LINE_UUID } from './db.ts'
import type { TranscriptFile, TranscriptLines, TranscriptState } from './runnerProtocol.ts'

/**
 * Every chat's transcript, on the hub. Claude Code writes transcripts on the
 * machine a chat runs on; its runner copies each file here line by line
 * (server/sync.ts), so the hub can list and show any chat, even while its
 * machine is away. The files on the machine stay the originals: Claude Code
 * resumes from them, and a line only ever arrives here after it's written there.
 *
 * The SDK reads transcripts through `store`, a read-only SessionStore over
 * these tables. It isn't handed to Claude Code itself: resuming from a store
 * runs Claude Code under a temporary config folder, without the user's own
 * skills, plugins and memory.
 */
export class Transcripts {
  readonly store: SessionStore

  constructor(private db: DatabaseSync) {
    const self = this
    this.store = {
      append: async () => {
        throw new Error('Transcripts are copied from the machine that ran them, not written here')
      },
      load: async (key: SessionKey) => self.entries(key.sessionId, key.subpath ?? ''),
      listSessions: async () => self.summaries().map(({ sessionId, mtime }) => ({ sessionId, mtime })),
      listSessionSummaries: async () => self.summaries(),
      listSubkeys: async ({ sessionId }) => self.subpaths(sessionId),
    }
  }

  state(files: TranscriptFile[]): TranscriptState[] {
    const get = this.db.prepare('SELECT lines, bytes FROM transcript_files WHERE session_id = ? AND subpath = ?')
    return files.map((f) => {
      const row = get.get(f.sessionId, f.subpath) as { lines: number; bytes: number } | undefined
      return { sessionId: f.sessionId, subpath: f.subpath, lines: row?.lines ?? 0, bytes: row?.bytes ?? 0 }
    })
  }

  /** Adds lines where they continue what's here. Returns what's here afterwards; the caller checks it moved on. */
  append(batch: TranscriptLines): TranscriptState {
    const { sessionId, subpath } = batch
    const [current] = this.state([batch])
    if (batch.reset) {
      // Claude Code rewrote the file. What it had is kept: it can't be had again.
      this.db
        .prepare('INSERT INTO transcript_lines_replaced (session_id, subpath, n, entry, replaced_at) SELECT session_id, subpath, n, entry, ? FROM transcript_lines WHERE session_id = ? AND subpath = ?')
        .run(Date.now(), sessionId, subpath)
      this.db.prepare('DELETE FROM transcript_lines WHERE session_id = ? AND subpath = ?').run(sessionId, subpath)
      if (!subpath) this.db.prepare('DELETE FROM transcript_summaries WHERE session_id = ?').run(sessionId)
      current.lines = current.bytes = 0
    }
    if (batch.fromLine !== current.lines || batch.fromBytes !== current.bytes) return current
    const insert = this.db.prepare('INSERT OR REPLACE INTO transcript_lines (session_id, subpath, n, entry) VALUES (?, ?, ?, ?)')
    batch.lines.forEach((line, i) => insert.run(sessionId, subpath, current.lines + i, line))
    this.db
      .prepare(
        `INSERT INTO transcript_files (session_id, subpath, project, lines, bytes, mtime, meta) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (session_id, subpath) DO UPDATE SET project = excluded.project, lines = excluded.lines, bytes = excluded.bytes,
           mtime = excluded.mtime, meta = COALESCE(excluded.meta, meta)`,
      )
      .run(sessionId, subpath, batch.project, current.lines + batch.lines.length, batch.bytes, batch.mtime, batch.meta ? JSON.stringify(batch.meta) : null)
    if (!subpath) this.summarise(batch)
    return { sessionId, subpath, lines: current.lines + batch.lines.length, bytes: batch.bytes }
  }

  /** Keeps the chat's summary current, the way the SDK's own stores do. Its time is the file's, so chats sort by when they last changed. */
  private summarise(batch: TranscriptLines): void {
    const row = this.db.prepare('SELECT mtime, data FROM transcript_summaries WHERE session_id = ?').get(batch.sessionId) as
      | { mtime: number; data: string }
      | undefined
    const prev: SessionSummaryEntry | undefined = row && { sessionId: batch.sessionId, mtime: row.mtime, data: JSON.parse(row.data) }
    const next = foldSessionSummary(prev, { projectKey: batch.project, sessionId: batch.sessionId }, parse(batch.lines), { mtime: batch.mtime })
    this.db
      .prepare(
        'INSERT INTO transcript_summaries (session_id, mtime, data) VALUES (?, ?, ?) ON CONFLICT (session_id) DO UPDATE SET mtime = excluded.mtime, data = excluded.data',
      )
      .run(batch.sessionId, next.mtime, JSON.stringify(next.data))
  }

  /** A transcript file's lines, as copied, and a subagent's metadata; undefined if there's no such file. */
  private file(sessionId: string, subpath: string): { lines: string[]; meta?: Record<string, unknown> } | undefined {
    const file = this.db.prepare('SELECT meta FROM transcript_files WHERE session_id = ? AND subpath = ?').get(sessionId, subpath) as
      | { meta: string | null }
      | undefined
    if (!file) return undefined
    const rows = this.db.prepare('SELECT entry FROM transcript_lines WHERE session_id = ? AND subpath = ? ORDER BY n').all(sessionId, subpath) as {
      entry: string
    }[]
    return { lines: rows.map((r) => r.entry), ...(file.meta ? { meta: JSON.parse(file.meta) } : {}) }
  }

  /** A transcript file's entries, or null if there isn't one. A subagent's metadata goes last, as the SDK's own stores keep it. */
  private entries(sessionId: string, subpath: string): SessionStoreEntry[] | null {
    const file = this.file(sessionId, subpath)
    if (!file) return null
    const entries = parse(file.lines)
    if (file.meta) entries.push({ type: 'agent_metadata', ...file.meta })
    return entries
  }

  /** Every chat's summary, or just one's. */
  private summaries(sessionId?: string): SessionSummaryEntry[] {
    const rows = (
      sessionId === undefined
        ? this.db.prepare('SELECT session_id, mtime, data FROM transcript_summaries').all()
        : this.db.prepare('SELECT session_id, mtime, data FROM transcript_summaries WHERE session_id = ?').all(sessionId)
    ) as { session_id: string; mtime: number; data: string }[]
    return rows.map((r) => ({ sessionId: r.session_id, mtime: r.mtime, data: JSON.parse(r.data) }))
  }

  private subpaths(sessionId: string): string[] {
    const rows = this.db.prepare("SELECT subpath FROM transcript_files WHERE session_id = ? AND subpath != ''").all(sessionId) as { subpath: string }[]
    return rows.map((r) => r.subpath)
  }

  /** The line holding one of a chat's messages with images, its subagents' included, if it has been copied here. */
  private imageLine(sessionId: string, uuid: string): string | undefined {
    const row = this.db
      .prepare(`SELECT entry FROM transcript_lines INDEXED BY transcript_lines_images WHERE session_id = ? AND ${IMAGE_LINE_UUID} = ? AND ${IMAGE_LINE} LIMIT 1`)
      .get(sessionId, uuid) as { entry: string } | undefined
    return row?.entry
  }

  /** The entry for one of a chat's messages with images, or undefined if it hasn't been copied here. */
  imageEntry(sessionId: string, uuid: string): Record<string, unknown> | undefined {
    const line = this.imageLine(sessionId, uuid)
    return line === undefined ? undefined : (parse([line])[0] as Record<string, unknown> | undefined)
  }

  /** Whether a message with images has been copied here, so they can be served from here. */
  hasImageEntry(sessionId: string, uuid: string): boolean {
    return this.imageLine(sessionId, uuid) !== undefined
  }

  /** A chat's subagents' transcripts, as their lines, with each one's metadata. */
  subagentFiles(sessionId: string): { subpath: string; lines: string[]; meta?: Record<string, unknown> }[] {
    return this.subpaths(sessionId).flatMap((subpath) => {
      const file = this.file(sessionId, subpath)
      // Lines too long to copy came over blank.
      return file ? [{ subpath, ...file, lines: file.lines.filter(Boolean) }] : []
    })
  }

  /** The most recently changed chats, newest first, less the `except` ones: left out before the limit, so they can't crowd others out. */
  list(limit: number, except: Set<string>): Promise<SDKSessionInfo[]> {
    const listed = () => this.summaries().filter((s) => !except.has(s.sessionId))
    return listSessions({
      sessionStore: { ...this.store, listSessions: async () => listed().map(({ sessionId, mtime }) => ({ sessionId, mtime })), listSessionSummaries: async () => listed() },
      limit,
    })
  }

  /** One chat's title, folder and so on, without reading its transcript. */
  async info(sessionId: string): Promise<SDKSessionInfo | undefined> {
    const one = this.summaries(sessionId)
    if (!one.length) return undefined
    const [info] = await listSessions({
      sessionStore: { ...this.store, listSessions: async () => one, listSessionSummaries: async () => one },
    })
    return info
  }

  /**
   * A chat's transcript, with what the SDK's reader leaves out put back:
   * turn results, the history before each compaction, the context Claude Code
   * added (see contextOf), which messages are meta, and subagents' work.
   * Subagent messages come last; each carries the parent_tool_use_id of the call that started it.
   */
  async transcript(id: string): Promise<WireMessage[]> {
    const entries = (this.entries(id, '') ?? []) as Entry[]
    const [messages, subagents] = await Promise.all([this.mainMessages(id, entries).catch(() => []), this.subagentMessages(id).catch(() => [])])
    const { meta, apiErrors, added } = contextOf(entries)
    // Each added message goes after the nearest message it descends from, so it's where it happened.
    const listed = new Set(messages.map((m) => m.uuid))
    const parents = new Map(entries.flatMap((e) => (e.uuid ? [[e.uuid, e.parentUuid ?? undefined] as const] : [])))
    const after = new Map<string | undefined, WireMessage[]>()
    for (const { message, parent } of added) {
      let at = parent
      while (at && !listed.has(at)) at = parents.get(at)
      after.set(at, [...(after.get(at) ?? []), message])
    }
    return [
      ...withTurnResults(
        messages.flatMap((m) => [
          // e.g. a subagent's report handed back, which would otherwise read as something the user typed.
          meta.has(m.uuid ?? '') || m.is_meta ? { ...m, isMeta: true } : m,
          ...(m.uuid ? (after.get(m.uuid) ?? []) : []),
        ]),
      ).map((m) => (m.uuid && apiErrors.has(m.uuid) ? { ...m, isApiErrorMessage: true, error: apiErrors.get(m.uuid) } : m)),
      ...(after.get(undefined) ?? []),
      ...subagents,
    ]
  }

  /**
   * The chat's own messages. The SDK's reader starts at the last compaction,
   * so it's run once per compaction on the entries before it, each run giving
   * the history since the one before, and the compaction goes between them.
   * Messages a compaction kept appear again after it, and are skipped there.
   */
  private async mainMessages(id: string, entries: Entry[]): Promise<WireMessage[]> {
    const cuts = entries.flatMap((e, i) => (e.type === 'system' && e.subtype === 'compact_boundary' ? [i] : []))
    const read = (end: number) => {
      const sessionStore: SessionStore = { ...this.store, load: async (key) => (key.subpath ? this.store.load(key) : (entries.slice(0, end) as SessionStoreEntry[])) }
      return getSessionMessages(id, { sessionStore }) as Promise<unknown> as Promise<WireMessage[]>
    }
    if (!cuts.length) return read(entries.length)
    const seen = new Set<string>()
    const out: WireMessage[] = []
    for (const end of [...cuts, entries.length]) {
      for (const m of await read(end)) {
        if (m.uuid && seen.has(m.uuid)) continue
        if (m.uuid) seen.add(m.uuid)
        out.push(m)
      }
      if (end < entries.length) out.push(compactBoundary(entries[end]))
    }
    return out
  }

  private async subagentMessages(id: string): Promise<WireMessage[]> {
    const agents = await listSubagents(id, { sessionStore: this.store })
    const each = await Promise.all(agents.map((agent) => getSubagentMessages(id, agent, { sessionStore: this.store }).catch(() => [])))
    return each.flat() as unknown as WireMessage[]
  }

  /**
   * Context from a live chat's newest lines, which its process doesn't send:
   * what hooks added, CLAUDE.md files loaded, a typed skill's instructions.
   * Only what came from `uuids`, so each goes out once. Reads the lines that
   * can hold context, since an attachment's anchor may be in an earlier batch.
   */
  liveContext(id: string, uuids: Set<string>): WireMessage[] {
    const rows = this.db
      .prepare(`SELECT entry FROM transcript_lines WHERE session_id = ? AND subpath = '' AND (entry LIKE '%"attachment"%' OR entry LIKE '%"isMeta":true%') ORDER BY n`)
      .all(id) as { entry: string }[]
    return contextOf(parse(rows.map((r) => r.entry)) as Entry[])
      .added.filter((a) => uuids.has(a.source) && a.message.type !== 'system')
      .map((a) => a.message)
  }
}

/** A raw transcript entry, as far as Badger reads them. */
type Entry = {
  type?: string
  subtype?: string
  uuid?: string
  parentUuid?: string | null
  timestamp?: string
  isMeta?: boolean
  isApiErrorMessage?: boolean
  error?: string
  sourceToolUseID?: string
  content?: unknown
  message?: { content?: unknown }
  attachment?: { type?: string; hookName?: string; hookEvent?: string; toolUseID?: string; content?: unknown; files?: unknown; stderr?: string; stdout?: string; command?: string; exitCode?: number }
  compactMetadata?: { trigger?: string; preTokens?: number; durationMs?: number }
  [key: string]: unknown
}

/** A compaction as the live stream reports it. */
function compactBoundary(e: Entry): WireMessage {
  const m = e.compactMetadata ?? {}
  return { type: 'system', subtype: 'compact_boundary', uuid: e.uuid, timestamp: e.timestamp, compact_metadata: { trigger: m.trigger, pre_tokens: m.preTokens, duration_ms: m.durationMs } }
}

/** A user-role entry's text, its blocks joined. */
function entryText(e: Entry): string {
  const content = e.message?.content
  if (typeof content === 'string') return content
  return Array.isArray(content) ? content.map((b: { type?: string; text?: string }) => (b?.type === 'text' ? (b.text ?? '') : '')).join('\n') : ''
}

/**
 * What getSessionMessages leaves out, read from raw entries: which messages
 * are meta and which are API errors, and context Claude Code added, as
 * messages for the client (shared/protocol.ts ContextMessage) with the entry
 * each came from and the one it descends from. Context about a call names it
 * with `tool_use_id`; the rest has an `anchor`, the nearest message it came
 * after, which the client places in its turn.
 */
function contextOf(entries: Entry[]): { meta: Set<string>; apiErrors: Map<string, string>; added: { message: WireMessage; source: string; parent?: string }[] } {
  const meta = new Set<string>()
  const apiErrors = new Map<string, string>()
  const added: { message: WireMessage; source: string; parent?: string }[] = []
  // Attachments chain off each other and off meta messages, like a skill's instructions after its /skill
  // prompt; the first ancestor that's neither is where they came in.
  const attachments = new Map(entries.flatMap((e) => ((e.type === 'attachment' || e.isMeta) && e.uuid ? [[e.uuid, e.parentUuid ?? undefined] as const] : [])))
  const anchorOf = (e: Entry) => {
    let at = e.parentUuid ?? undefined
    while (at && attachments.has(at)) at = attachments.get(at)
    return at
  }
  const add = (e: Entry, message: WireMessage, parent = anchorOf(e)) => added.push({ message, source: e.uuid!, parent })
  /** On a call when it's about one, otherwise anchored where it came in. */
  const place = (e: Entry, toolUseId?: string) => (toolUseId?.startsWith('toolu_') ? { tool_use_id: toolUseId } : { anchor: anchorOf(e) })
  for (const e of entries) {
    if (!e.uuid) continue
    if (e.isMeta) meta.add(e.uuid)
    if (e.type === 'assistant' && e.isApiErrorMessage) apiErrors.set(e.uuid, e.error ?? 'unknown')
    const a = e.attachment
    if (e.type === 'attachment' && a) {
      if (a.type === 'hook_additional_context' && Array.isArray(a.content)) {
        a.content.forEach((text, i) => {
          if (typeof text === 'string' && text.trim()) add(e, { type: 'hook_context', uuid: `${e.uuid}-${i}`, hook: a.hookName, text, ...place(e, a.toolUseID) })
        })
      } else if (a.type === 'hook_non_blocking_error' || a.type === 'hook_blocking_error') {
        const error = (a.stderr || a.stdout || '').replace(/^Failed with non-blocking status code: /, '').trim()
        add(e, { type: 'hook_error', uuid: e.uuid, hook: a.hookName, command: a.command, exit_code: a.exitCode, error, ...place(e, a.toolUseID) })
      } else if (a.type === 'instructions' && Array.isArray(a.files)) {
        const files = (a.files as { path?: string; type?: string; content?: string }[]).filter((f) => f?.path).map((f) => ({ path: f.path, type: f.type, content: f.content ?? '' }))
        if (files.length) add(e, { type: 'instructions', uuid: e.uuid, files, anchor: anchorOf(e) })
      }
    } else if (e.type === 'user' && e.isMeta) {
      // A skill's instructions: after the Skill call that loaded them, or the /skill prompt that did.
      const text = entryText(e)
      if (text.startsWith('Base directory for this skill:')) {
        const where = e.sourceToolUseID ? { tool_use_id: e.sourceToolUseID } : { anchor: e.parentUuid ?? undefined }
        add(e, { type: 'skill', uuid: `${e.uuid}-skill`, text, ...where }, e.parentUuid ?? undefined)
      }
    } else if (e.type === 'system' && e.subtype === 'local_command') {
      // A built-in command's output; live, it arrives as a message from the "<synthetic>" model with this uuid.
      add(e, { type: 'system', subtype: 'local_command', uuid: e.uuid, content: e.content }, e.parentUuid ?? undefined)
    } else if (e.type === 'system' && e.subtype === 'model_refusal_fallback') {
      add(
        e,
        {
          type: 'system',
          subtype: 'model_refusal_fallback',
          uuid: e.uuid,
          content: e.content,
          original_model: e.originalModel,
          fallback_model: e.fallbackModel,
          scope: e.scope,
          api_refusal_category: e.apiRefusalCategory,
          refused_user_message_uuid: e.refusedUserMessageUuid,
          retracted_message_uuids: e.retractedMessageUuids,
        },
        e.parentUuid ?? undefined,
      )
    }
  }
  return { meta, apiErrors, added }
}

/** Lines that parse; a torn or corrupt one is skipped rather than losing the rest. */
function parse(lines: string[]): SessionStoreEntry[] {
  const out: SessionStoreEntry[] = []
  for (const line of lines) {
    try {
      out.push(JSON.parse(line))
    } catch {}
  }
  return out
}

type Usage = { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }

/**
 * The transcript has no result messages (time taken, tokens), so rebuild one
 * after each turn from message timestamps and each API call's usage.
 * Main agent only, like the live results the client shows.
 */
function withTurnResults(messages: WireMessage[]): WireMessage[] {
  const out: WireMessage[] = []
  let start: WireMessage | undefined
  let last: WireMessage | undefined
  let calls = new Map<string, Usage>()
  const close = () => {
    if (start && last?.uuid) {
      const usage: Required<Usage> = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
      for (const u of calls.values()) for (const k of Object.keys(usage) as (keyof Usage)[]) usage[k] += u[k] ?? 0
      const ended = Date.parse(String(last.timestamp))
      out.push({
        type: 'result',
        subtype: 'success',
        uuid: `${last.uuid}-result`,
        after_uuid: last.uuid,
        duration_ms: ended - Date.parse(String(start.timestamp)),
        ended_at: ended,
        usage,
      })
    }
    start = last = undefined
    calls = new Map()
  }
  for (const m of messages) {
    if (isPrompt(m)) {
      close()
      start = m
    } else if (start && m.type === 'assistant' && !m.parent_tool_use_id) {
      last = m
      // One API call is split into a line per content block, all sharing its id and usage.
      const msg = m.message as { id?: string; usage?: Usage } | undefined
      if (msg?.id && msg.usage) calls.set(msg.id, msg.usage)
    }
    out.push(m)
  }
  close()
  return out
}

/** A message the user typed, as opposed to tool results or injected context. */
function isPrompt(m: WireMessage): boolean {
  if (m.type !== 'user' || m.parent_tool_use_id || m.isMeta || m.isCompactSummary || !m.timestamp) return false
  const content = (m.message as { content?: unknown } | undefined)?.content
  // A slash command the user typed is a prompt too; other tagged text was added by Claude Code.
  const typed = (text: string) => !text.trimStart().startsWith('<') || /^\s*<command-(message|name)>/.test(text)
  if (typeof content === 'string') return typed(content)
  return Array.isArray(content) && content.some((b) => b?.type === 'text' && typed(String(b.text)))
}

/** What a chat is called: the title someone gave it, else Claude Code's summary, else how it started. */
export const titleOf = (info: Pick<SDKSessionInfo, 'customTitle' | 'summary' | 'firstPrompt'> | undefined): string | undefined =>
  info?.customTitle || info?.summary || info?.firstPrompt

/** The model a transcript's main agent last answered with: a model id, e.g. `claude-opus-5-5`. */
export function transcriptModel(messages: WireMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    const model = m.type === 'assistant' && !m.parent_tool_use_id && (m.message as { model?: string } | undefined)?.model
    // API errors are recorded as answers from a "<synthetic>" model.
    if (model && !model.startsWith('<')) return model
  }
  return undefined
}
