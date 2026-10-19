import { appendFile, mkdir, open, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { message } from './errors.ts'
import type { Remote } from './peer.ts'
import { RUNNER_MAX_FRAME, isUuid, type HubApi, type TranscriptState } from './runnerProtocol.ts'

/** How often the files of live chats are checked, besides after each of their messages. */
const LIVE_POLL_MS = 2000
/** How often every chat's transcript is checked, for chats resumed outside Badger (the CLI). */
const SCAN_MS = 60 * 1000
/** Most bytes of transcript read in one go. A single longer line is still read whole. */
const CHUNK_BYTES = 4 * 1024 * 1024
/**
 * Most bytes of lines in one batch, as escaped in its frame: half a frame, the
 * rest left for everything else in it. A line bigger than this on its own goes
 * as a blank one, which the hub skips.
 */
const BATCH_BYTES = RUNNER_MAX_FRAME / 2
/** Times the hub's idea of where a file is up to can differ from this one's before it's left for the next pass. */
const MAX_MISMATCHES = 5
/** Files asked about in one call when (re)connecting. */
const STATE_BATCH = 500

/** Where Claude Code keeps transcripts, a folder per project. */
const projectsDir = () => join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects')

/**
 * Writes part of a chat's transcript where Claude Code keeps those of chats in
 * `cwd`, e.g. a fork made on the hub. `subpath` is as in LocalFile; a
 * subagent's metadata goes beside its file. A file's first part makes it, and
 * fails if it's there already.
 */
export async function writeTranscript(
  sessionId: string,
  cwd: string,
  file: { subpath: string; lines: string[]; append: boolean; meta?: Record<string, unknown> },
): Promise<void> {
  // Claude Code shortens long names with a hash too, but it looks in every project folder for a chat to resume.
  const project = join(projectsDir(), cwd.replace(/[^a-zA-Z0-9]/g, '-').slice(0, 200))
  const path = file.subpath ? join(project, sessionId, `${file.subpath}.jsonl`) : join(project, `${sessionId}.jsonl`)
  await mkdir(dirname(path), { recursive: true })
  const text = file.lines.map((l) => `${l}\n`).join('')
  if (file.append) await appendFile(path, text)
  else await writeFile(path, text, { flag: 'wx' })
  if (file.meta) await writeFile(path.replace(/\.jsonl$/, '.meta.json'), JSON.stringify(file.meta))
}

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
  private readonly projects = projectsDir()
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
    const files = await this.localFiles()
    const unknown = files.filter((f) => !this.known.has(key(f)))
    try {
      for (let i = 0; i < unknown.length; i += STATE_BATCH) {
        const batch = unknown.slice(i, i + STATE_BATCH).map(({ sessionId, subpath }) => ({ sessionId, subpath }))
        for (const state of await this.hub.transcriptState(batch)) this.known.set(key(state), state)
      }
    } catch (err) {
      // Those not asked about yet are asked one by one as they're sent.
      if (this.connected) console.error('Asking the hub about transcripts failed:', message(err))
    }
    for (const id of this.live()) this.dirty.add(id)
    // Subagents' files included: one left half-sent when the connection dropped may be done with, its chat not changing again.
    for (const f of files) if (this.known.get(key(f))?.bytes !== f.size) this.dirty.add(f.sessionId)
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
        if (this.connected) console.error(`Copying chat ${id} to the hub failed:`, message(err))
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
    for (let mismatches = 0; mismatches < MAX_MISMATCHES; ) {
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
        ...(lines?.more ? { more: true } : {}),
      })
      state = result
      this.known.set(k, state)
      // A mismatch means the hub had a different idea of where the file was up to, and took none of it: go again from there.
      if (result.bytes !== sent) {
        mismatches++
        continue
      }
      if (meta) this.metas.set(k, meta.raw)
      meta = undefined
      // There may be more than one chunk's worth.
      if (sent >= info.size || !lines) return
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

  /** Every transcript file of this machine's chats, theirs and their subagents', with their sizes. */
  private async localFiles(): Promise<(LocalFile & { size: number })[]> {
    const chats = this.chats()
    const mains: (LocalFile & { size: number; mtime: number })[] = []
    for (const project of await readdir(this.projects).catch(() => [])) {
      for (const name of await readdir(join(this.projects, project)).catch(() => [])) {
        const sessionId = name.slice(0, -'.jsonl'.length)
        if (!name.endsWith('.jsonl') || !isUuid(sessionId) || !chats.has(sessionId)) continue
        const path = join(this.projects, project, name)
        const info = await stat(path).catch(() => undefined)
        if (info?.isFile()) mains.push({ sessionId, subpath: '', project, path, size: info.size, mtime: info.mtimeMs })
      }
    }
    // Newest first, so the chats someone is likely to open are copied first when there's a lot to send.
    mains.sort((a, b) => b.mtime - a.mtime)
    const out: (LocalFile & { size: number })[] = []
    for (const main of mains) {
      out.push(main)
      for (const file of await nestedFiles(main)) {
        const info = await stat(file.path).catch(() => undefined)
        if (info?.isFile()) out.push({ ...file, size: info.size })
      }
    }
    return out
  }

  /** A chat's transcript and its subagents', wherever Claude Code put it. */
  private async filesOf(sessionId: string): Promise<LocalFile[]> {
    for (const project of await readdir(this.projects).catch(() => [])) {
      const path = join(this.projects, project, `${sessionId}.jsonl`)
      if (!(await stat(path).then((s) => s.isFile(), () => false))) continue
      const main = { sessionId, subpath: '', project, path }
      return [main, ...(await nestedFiles(main))]
    }
    return []
  }
}

/** The subagents' transcripts in a chat's folder, beside its own. */
async function nestedFiles(main: LocalFile): Promise<LocalFile[]> {
  const dir = main.path.slice(0, -'.jsonl'.length)
  const nested = (await readdir(dir, { recursive: true }).catch(() => [] as string[])).filter((p) => p.endsWith('.jsonl'))
  return nested.map((p) => ({ ...main, subpath: relative(dir, join(dir, p)).slice(0, -'.jsonl'.length).split(sep).join('/'), path: join(dir, p) }))
}

const key = (f: { sessionId: string; subpath: string }) => `${f.sessionId}\0${f.subpath}`

/**
 * Whole lines from an offset, no more than fit in a batch, and where the last
 * one ends; undefined if there's no whole line yet. Over-long lines come back
 * blank. `more`: there are whole lines after these.
 */
async function readLines(path: string, from: number, size: number): Promise<{ lines: string[]; bytes: number; more: boolean } | undefined> {
  if (size <= from) return undefined
  const fh = await open(path, 'r')
  try {
    for (let want = Math.min(CHUNK_BYTES, size - from); ; want = Math.min(want * 2, size - from)) {
      const buf = Buffer.alloc(want)
      const { bytesRead } = await fh.read(buf, 0, want, from)
      const end = buf.subarray(0, bytesRead).lastIndexOf(0x0a)
      if (end >= 0) {
        const lines: string[] = []
        let at = 0
        let total = 0
        while (at <= end) {
          const nl = buf.indexOf(0x0a, at)
          const line = buf.subarray(at, nl).toString('utf8')
          // As it goes in the frame: quotes and backslashes, of which JSON lines have plenty, take two bytes there.
          const escaped = Buffer.byteLength(JSON.stringify(line))
          const taken = escaped > BATCH_BYTES ? '' : line
          const cost = taken ? escaped : 2
          if (lines.length && total + cost > BATCH_BYTES) break
          lines.push(taken)
          total += cost
          at = nl + 1
        }
        // Not all read, the rest may be whole lines; all read, only a line still being written may be left.
        return { lines, bytes: from + at, more: at <= end || from + bytesRead < size }
      }
      // No newline yet: either the line is still being written, or it's longer than a chunk.
      if (want >= size - from) return undefined
    }
  } finally {
    await fh.close()
  }
}
