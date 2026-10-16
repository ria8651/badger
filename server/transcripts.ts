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

  /** A transcript file's entries, or null if there isn't one. A subagent's metadata goes last, as the SDK's own stores keep it. */
  private entries(sessionId: string, subpath: string): SessionStoreEntry[] | null {
    const file = this.db.prepare('SELECT meta FROM transcript_files WHERE session_id = ? AND subpath = ?').get(sessionId, subpath) as
      | { meta: string | null }
      | undefined
    if (!file) return null
    const rows = this.db.prepare('SELECT entry FROM transcript_lines WHERE session_id = ? AND subpath = ? ORDER BY n').all(sessionId, subpath) as {
      entry: string
    }[]
    const entries = parse(rows.map((r) => r.entry))
    if (file.meta) entries.push({ type: 'agent_metadata', ...JSON.parse(file.meta) })
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

  /** The entry for one of a chat's messages with images, its subagents' included, or undefined if it hasn't been copied here. */
  imageEntry(sessionId: string, uuid: string): Record<string, unknown> | undefined {
    const row = this.db
      .prepare(`SELECT entry FROM transcript_lines INDEXED BY transcript_lines_images WHERE session_id = ? AND ${IMAGE_LINE_UUID} = ? AND ${IMAGE_LINE} LIMIT 1`)
      .get(sessionId, uuid) as { entry: string } | undefined
    return row ? (parse([row.entry])[0] as Record<string, unknown> | undefined) : undefined
  }

  /** Whether a message with images has been copied here, so they can be served from here. */
  hasImageEntry(sessionId: string, uuid: string): boolean {
    return !!this.db.prepare(`SELECT 1 FROM transcript_lines INDEXED BY transcript_lines_images WHERE session_id = ? AND ${IMAGE_LINE_UUID} = ? AND ${IMAGE_LINE} LIMIT 1`).get(sessionId, uuid)
  }

  /** A chat's subagents' transcripts, as their lines, with each one's metadata. */
  subagentFiles(sessionId: string): { subpath: string; lines: string[]; meta?: Record<string, unknown> }[] {
    return this.subpaths(sessionId).map((subpath) => {
      const file = this.db.prepare('SELECT meta FROM transcript_files WHERE session_id = ? AND subpath = ?').get(sessionId, subpath) as { meta: string | null }
      const rows = this.db.prepare('SELECT entry FROM transcript_lines WHERE session_id = ? AND subpath = ? ORDER BY n').all(sessionId, subpath) as {
        entry: string
      }[]
      // Lines too long to copy came over blank.
      return { subpath, lines: rows.map((r) => r.entry).filter(Boolean), ...(file.meta ? { meta: JSON.parse(file.meta) } : {}) }
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
   * turn results, hook context, which messages are meta, and subagents' work.
   * Subagent messages come last; each carries the parent_tool_use_id of the call that started it.
   */
  async transcript(id: string): Promise<WireMessage[]> {
    const [messages, subagents] = await Promise.all([
      getSessionMessages(id, { sessionStore: this.store }).catch(() => []) as Promise<unknown> as Promise<WireMessage[]>,
      this.subagentMessages(id).catch(() => []),
    ])
    const { context, meta } = this.extras(id)
    return [
      ...withTurnResults(
        messages.flatMap((m) => [
          // e.g. a subagent's report handed back, which would otherwise read as something the user typed.
          meta.has(m.uuid ?? '') ? { ...m, isMeta: true } : m,
          ...(context.get(m.uuid ?? '') ?? []).map((text, i) => ({ type: 'hook_context', uuid: `${m.uuid}-context-${i}`, after_uuid: m.uuid, text })),
        ]),
      ),
      ...subagents,
    ]
  }

  private async subagentMessages(id: string): Promise<WireMessage[]> {
    const agents = await listSubagents(id, { sessionStore: this.store })
    const each = await Promise.all(agents.map((agent) => getSubagentMessages(id, agent, { sessionStore: this.store }).catch(() => [])))
    return each.flat() as unknown as WireMessage[]
  }

  /**
   * What getSessionMessages leaves out, read from the raw entries: what
   * UserPromptSubmit hooks added to each turn (attachment entries), by the uuid
   * of the prompt it came with, and the uuids of messages marked meta.
   */
  private extras(id: string): { context: Map<string, string[]>; meta: Set<string> } {
    const out = new Map<string, string[]>()
    const meta = new Set<string>()
    const rows = this.db
      .prepare(
        `SELECT entry FROM transcript_lines WHERE session_id = ? AND subpath = '' AND (entry LIKE '%"attachment"%' OR entry LIKE '%"isMeta":true%') ORDER BY n`,
      )
      .all(id) as { entry: string }[]
    type Entry = { type?: string; uuid?: string; parentUuid?: string; isMeta?: boolean; attachment?: { type?: string; hookEvent?: string; content?: unknown } }
    const parents = new Map<string, string>()
    const hooks: Entry[] = []
    for (const e of parse(rows.map((r) => r.entry)) as Entry[]) {
      if (e.isMeta && e.uuid) meta.add(e.uuid)
      if (e.type !== 'attachment' || !e.uuid || !e.parentUuid) continue
      parents.set(e.uuid, e.parentUuid)
      if (e.attachment?.type === 'hook_additional_context' && e.attachment.hookEvent === 'UserPromptSubmit') hooks.push(e)
    }
    for (const e of hooks) {
      // Attachments chain off each other; the first non-attachment ancestor is the prompt.
      let anchor = e.parentUuid!
      while (parents.has(anchor)) anchor = parents.get(anchor)!
      const content = Array.isArray(e.attachment!.content) ? e.attachment!.content.filter((c): c is string => typeof c === 'string') : []
      out.set(anchor, [...(out.get(anchor) ?? []), ...content])
    }
    return { context: out, meta }
  }
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
  if (m.type !== 'user' || m.parent_tool_use_id || m.isMeta || !m.timestamp) return false
  const content = (m.message as { content?: unknown } | undefined)?.content
  if (typeof content === 'string') return !content.trimStart().startsWith('<')
  return Array.isArray(content) && content.some((b) => b?.type === 'text' && !String(b.text).trimStart().startsWith('<'))
}

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
