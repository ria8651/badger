import { open, readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, relative, sep } from 'node:path'
import type { Remote } from './peer.ts'
import { RUNNER_MAX_FRAME, isUuid, type HubApi, type TranscriptState } from './runnerProtocol.ts'

/** How often the files of live chats are checked, besides after each of their messages. */
const LIVE_POLL_MS = 2000
/** How often every chat's transcript is checked, for chats resumed outside Badger (the CLI). */
const SCAN_MS = 60 * 1000
/** Most bytes of transcript sent in one go. A single longer line still goes whole. */
const CHUNK_BYTES = 4 * 1024 * 1024
/** A line longer than this goes as a blank one, which the hub skips: it wouldn't fit in a frame once escaped as JSON. */
const MAX_LINE_BYTES = RUNNER_MAX_FRAME / 2
/** Files asked about in one call when (re)connecting. */
const STATE_BATCH = 500

interface LocalFile {
  sessionId: string
  /** '' for the chat's own transcript, else its path under the chat's folder without `.jsonl`, e.g. `subagents/agent-<id>`. */
  subpath: string
  project: string
  path: string
}

/**
 * Copies the transcripts of the chats the hub has put on this machine to the
 * hub, line by line, so it can show them while this machine is away. Other
 * Claude Code chats here, e.g. the CLI's, stay here. The files are the
 * outbox: the hub says how much of each it has, and this sends the rest, so a
 * dropped connection or a restart on either side just picks up where it left
 * off. Lines are only sent once they're whole.
 */
export class TranscriptSync {
  private readonly projects = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects')
  /** What the hub has of each file, as far as this connection knows; cleared when it reconnects. */
  private known = new Map<string, TranscriptState>()
  /** Subagent metadata sent this connection, by file, so it's only sent again when it changes. */
  private metas = new Map<string, string>()
  private dirty = new Set<string>()
  private running: Promise<void> | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private connected = false

  constructor(
    private hub: Remote<HubApi>,
    /** Chats with a live process here, whose files change as they work. */
    private live: () => string[],
    /** The chats the hub has put on this machine; no others are sent. */
    private chats: () => ReadonlySet<string>,
  ) {
    setInterval(() => this.connected && this.touch(...this.live()), LIVE_POLL_MS).unref()
    setInterval(() => this.connected && void this.scan(), SCAN_MS).unref()
  }

  /** The hub (re)connected: it may have anything or nothing, so ask it again about everything. */
  start(): void {
    this.connected = true
    this.known.clear()
    this.metas.clear()
    void this.scan()
  }

  stop(): void {
    this.connected = false
  }

  /** These chats' transcripts may have grown; send what's new shortly. */
  touch(...sessionIds: string[]): void {
    for (const id of sessionIds) this.dirty.add(id)
    this.timer ??= setTimeout(() => {
      this.timer = null
      void this.drain()
    }, 250)
  }

  /** Queues every chat whose transcript isn't the size the hub has, and the live ones. */
  private async scan(): Promise<void> {
    const mains = await this.mainFiles()
    const unknown = mains.filter((f) => !this.known.has(key(f)))
    try {
      for (let i = 0; i < unknown.length; i += STATE_BATCH) {
        const batch = unknown.slice(i, i + STATE_BATCH).map(({ sessionId, subpath }) => ({ sessionId, subpath }))
        for (const state of await this.hub.transcriptState(batch)) this.known.set(key(state), state)
      }
    } catch (err) {
      // Those not asked about yet are asked one by one as they're sent.
      if (this.connected) console.error('Asking the hub about transcripts failed:', err instanceof Error ? err.message : err)
    }
    for (const id of this.live()) this.dirty.add(id)
    // Subagents write to the chat's own transcript too, so a change shows there.
    for (const f of mains) if (this.known.get(key(f))?.bytes !== f.size) this.dirty.add(f.sessionId)
    await this.drain()
  }

  /** One pass over the queue at a time; anything queued meanwhile is taken by the pass already going. */
  private drain(): Promise<void> {
    // Cleared in a later tick than it's set, even when there's nothing to do.
    this.running ??= this.work().finally(() => (this.running = null))
    return this.running
  }

  private async work(): Promise<void> {
    while (this.connected && this.dirty.size) {
      // Live chats first, then whatever's oldest in the queue.
      const live = this.live().find((id) => this.dirty.has(id))
      const id = live ?? this.dirty.values().next().value!
      this.dirty.delete(id)
      if (!this.chats().has(id)) continue
      try {
        for (const file of await this.filesOf(id)) await this.push(file)
      } catch (err) {
        // The hub may have taken lines whose answer never came back, so ask it again where it's up to before sending more.
        for (const k of this.known.keys()) if (k.startsWith(`${id}\0`)) this.known.delete(k)
        // Gone again with the connection; otherwise it's tried again next time the chat changes or a scan comes round.
        if (this.connected) console.error(`Copying chat ${id} to the hub failed:`, err instanceof Error ? err.message : err)
      }
    }
  }

  /** Sends whatever of the file the hub doesn't have yet. */
  private async push(file: LocalFile): Promise<void> {
    const k = key(file)
    let state = this.known.get(k)
    if (!state) {
      ;[state] = await this.hub.transcriptState([{ sessionId: file.sessionId, subpath: file.subpath }])
      this.known.set(k, state)
    }
    let meta = file.subpath ? await this.meta(file, k) : undefined
    for (let attempts = 0; attempts < 5; attempts++) {
      const info = await stat(file.path).catch(() => undefined)
      if (!info) return
      const reset = info.size < state.bytes
      const from = reset ? { lines: 0, bytes: 0 } : state
      const lines = await readLines(file.path, from.bytes, info.size)
      if (!lines && !reset && !meta) return
      const sent = lines?.bytes ?? from.bytes
      const result = await this.hub.transcriptLines({
        sessionId: file.sessionId,
        subpath: file.subpath,
        project: file.project,
        fromLine: from.lines,
        fromBytes: from.bytes,
        lines: lines?.lines ?? [],
        bytes: sent,
        mtime: Math.floor(info.mtimeMs),
        ...(meta ? { meta: meta.value } : {}),
        ...(reset ? { reset } : {}),
      })
      state = result
      this.known.set(k, state)
      if (meta) this.metas.set(k, meta.raw)
      meta = undefined
      // A mismatch means the hub had a different idea of where the file was up to: go again from there.
      // Otherwise there may be more than one chunk's worth.
      if (result.bytes === sent && sent >= info.size) return
    }
  }

  /** A subagent's .meta.json, if it changed since it was last sent. */
  private async meta(file: LocalFile, key: string): Promise<{ raw: string; value: Record<string, unknown> } | undefined> {
    const raw = await readFile(file.path.replace(/\.jsonl$/, '.meta.json'), 'utf8').catch(() => undefined)
    if (!raw || this.metas.get(key) === raw) return undefined
    try {
      return { raw, value: JSON.parse(raw) }
    } catch {
      return undefined
    }
  }

  /** The main transcripts of this machine's chats, with their sizes. */
  private async mainFiles(): Promise<(LocalFile & { size: number; mtime: number })[]> {
    const chats = this.chats()
    const out: (LocalFile & { size: number; mtime: number })[] = []
    for (const project of await readdir(this.projects).catch(() => [])) {
      for (const name of await readdir(join(this.projects, project)).catch(() => [])) {
        const sessionId = name.slice(0, -'.jsonl'.length)
        if (!name.endsWith('.jsonl') || !isUuid(sessionId) || !chats.has(sessionId)) continue
        const path = join(this.projects, project, name)
        const info = await stat(path).catch(() => undefined)
        if (info?.isFile()) out.push({ sessionId, subpath: '', project, path, size: info.size, mtime: info.mtimeMs })
      }
    }
    // Newest first, so the chats someone is likely to open are copied first when there's a lot to send.
    return out.sort((a, b) => b.mtime - a.mtime)
  }

  /** A chat's transcript and its subagents', wherever Claude Code put it. */
  private async filesOf(sessionId: string): Promise<LocalFile[]> {
    for (const project of await readdir(this.projects).catch(() => [])) {
      const path = join(this.projects, project, `${sessionId}.jsonl`)
      if (!(await stat(path).then((s) => s.isFile(), () => false))) continue
      const dir = join(this.projects, project, sessionId)
      const nested = (await readdir(dir, { recursive: true }).catch(() => [] as string[])).filter((p) => p.endsWith('.jsonl'))
      return [
        { sessionId, subpath: '', project, path },
        ...nested.map((p) => ({ sessionId, subpath: relative(dir, join(dir, p)).slice(0, -'.jsonl'.length).split(sep).join('/'), project, path: join(dir, p) })),
      ]
    }
    return []
  }
}

const key = (f: { sessionId: string; subpath: string }) => `${f.sessionId}\0${f.subpath}`

/** The whole lines between two offsets, and where the last one ends; undefined if there's no whole line yet. Over-long lines come back blank. */
async function readLines(path: string, from: number, size: number): Promise<{ lines: string[]; bytes: number } | undefined> {
  if (size <= from) return undefined
  const fh = await open(path, 'r')
  try {
    for (let want = Math.min(CHUNK_BYTES, size - from); ; want = Math.min(want * 2, size - from)) {
      const buf = Buffer.alloc(want)
      const { bytesRead } = await fh.read(buf, 0, want, from)
      const end = buf.subarray(0, bytesRead).lastIndexOf(0x0a)
      if (end >= 0) {
        const text = buf.subarray(0, end).toString('utf8')
        const lines = text.split('\n').map((l) => (Buffer.byteLength(l) > MAX_LINE_BYTES ? '' : l))
        return { lines, bytes: from + end + 1 }
      }
      // No newline yet: either the line is still being written, or it's longer than a chunk.
      if (want >= size - from) return undefined
    }
  } finally {
    await fh.close()
  }
}
