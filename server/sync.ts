import { open, readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, relative, sep } from 'node:path'
import type { Remote } from './peer.ts'
import type { HubApi, TranscriptState } from './runnerProtocol.ts'

/** The newest chats copied when a runner connects. Older ones stay where they are until they change. */
const MAX_SESSIONS = 200
/** How often the files of live chats are checked, besides after each of their messages. */
const LIVE_POLL_MS = 2000
/** How often every transcript is checked, for chats run outside Badger (the CLI). */
const SCAN_MS = 60 * 1000
/** Most bytes of transcript sent in one go. A single longer line still goes whole. */
const CHUNK_BYTES = 4 * 1024 * 1024

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

interface LocalFile {
  sessionId: string
  /** '' for the chat's own transcript, else its path under the chat's folder without `.jsonl`, e.g. `subagents/agent-<id>`. */
  subpath: string
  project: string
  path: string
}

/**
 * Copies this machine's Claude Code transcripts to the hub, line by line, so
 * the hub can show every chat while this machine is away. The files are the
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
  /** Files of chats that belong to another machine; the hub won't take them. */
  private ignored = new Set<string>()
  private dirty = new Set<string>()
  private running: Promise<void> | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private connected = false

  constructor(
    private hub: Remote<HubApi>,
    /** Chats with a live process here, whose files change as they work. */
    private live: () => string[],
  ) {
    setInterval(() => this.connected && this.touch(...this.live()), LIVE_POLL_MS).unref()
    setInterval(() => this.connected && void this.scan(), SCAN_MS).unref()
  }

  /** The hub (re)connected: it may have anything or nothing, so ask it again about everything. */
  start(): void {
    this.connected = true
    this.known.clear()
    this.metas.clear()
    this.ignored.clear()
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

  /** Queues the newest chats, live ones first. */
  private async scan(): Promise<void> {
    const mains = await this.mainFiles()
    const newest = mains.sort((a, b) => b.mtime - a.mtime).slice(0, MAX_SESSIONS)
    for (const id of this.live()) this.dirty.add(id)
    for (const f of newest) this.dirty.add(f.sessionId)
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
      try {
        for (const file of await this.filesOf(id)) await this.push(file)
      } catch (err) {
        // Gone again with the connection; otherwise it's tried again next time the chat changes or a scan comes round.
        if (this.connected) console.error(`Copying chat ${id} to the hub failed:`, err instanceof Error ? err.message : err)
      }
    }
  }

  /** Sends whatever of the file the hub doesn't have yet. */
  private async push(file: LocalFile): Promise<void> {
    const key = `${file.sessionId}\0${file.subpath}`
    if (this.ignored.has(key)) return
    let state = this.known.get(key)
    if (!state) {
      ;[state] = await this.hub.transcriptState([file])
      this.known.set(key, state)
    }
    let meta = file.subpath ? await this.meta(file, key) : undefined
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
      if (result.ignored) return void this.ignored.add(key)
      state = result
      this.known.set(key, state)
      if (meta) this.metas.set(key, meta.raw)
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

  private async mainFiles(): Promise<(LocalFile & { mtime: number })[]> {
    const out: (LocalFile & { mtime: number })[] = []
    for (const project of await readdir(this.projects).catch(() => [])) {
      for (const name of await readdir(join(this.projects, project)).catch(() => [])) {
        const sessionId = name.slice(0, -'.jsonl'.length)
        if (!name.endsWith('.jsonl') || !UUID.test(sessionId)) continue
        const path = join(this.projects, project, name)
        const info = await stat(path).catch(() => undefined)
        if (info?.isFile()) out.push({ sessionId, subpath: '', project, path, mtime: info.mtimeMs })
      }
    }
    return out
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

/** The whole lines between two offsets, and where the last one ends; undefined if there's no whole line yet. */
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
        return { lines: text.split('\n'), bytes: from + end + 1 }
      }
      // No newline yet: either the line is still being written, or it's longer than a chunk.
      if (want >= size - from) return undefined
    }
  } finally {
    await fh.close()
  }
}
