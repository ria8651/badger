import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { StringDecoder } from 'node:string_decoder'

/**
 * Live Bash output. Claude Code only reports a command's output when it exits,
 * so we set CLAUDE_CODE_SHELL_PREFIX to a wrapper that tees output into a log
 * per command. The prefix is applied after permission checks, so allow rules
 * still match the original command. Here we tail those logs.
 */

export const STREAM_DIR = join(tmpdir(), 'badger-bash')
const PREFIX = fileURLToPath(new URL('./bash-stream.sh', import.meta.url))
const POLL_MS = 150
const READ_LIMIT = 256 * 1024
/** Output kept per command for snapshots; older output is dropped from the front. */
const KEEP = 64 * 1024

mkdirSync(STREAM_DIR, { recursive: true })
// Only when needed: deployed, the app's files belong to root, not the server's user.
if (!(statSync(PREFIX).mode & 0o111)) chmodSync(PREFIX, 0o755)

/** Env for query(); leaves a user-configured shell prefix alone (no streaming then). */
export function streamEnv(): Record<string, string | undefined> {
  if (process.env.CLAUDE_CODE_SHELL_PREFIX) return { ...process.env }
  return { ...process.env, CLAUDE_CODE_SHELL_PREFIX: PREFIX, BADGER_STREAM_DIR: STREAM_DIR }
}

/** How Claude Code quotes the command inside its shell string: `eval '<cmd>'`. */
const evalForm = (command: string) => `eval '${command.replaceAll("'", `'"'"'`)}'`

interface Stream {
  toolUseId: string
  needle: string
  file?: string
  offset: number
  decoder: StringDecoder
  output: string
  /** Left running in the background: followed until its task ends, not its tool_result. */
  taskId?: string
}

export class BashStreams {
  private streams = new Map<string, Stream>()
  /** What background commands printed, once they've ended, for snapshots. */
  private ended = new Map<string, string>()
  private timer: NodeJS.Timeout | null = null

  constructor(
    private sessionId: string,
    private onOutput: (toolUseId: string, chunk: string) => void,
    /** The command started running: the wrapper only runs once permission checks have passed. */
    private onStart?: (toolUseId: string) => void,
  ) {}

  /** Called from the PreToolUse hook, before the command runs (or is approved). */
  track(toolUseId: string, command: string): void {
    this.streams.set(toolUseId, { toolUseId, needle: evalForm(command), offset: 0, decoder: new StringDecoder('utf8'), output: '' })
    this.timer ??= setInterval(() => this.poll(), POLL_MS)
  }

  /**
   * A command's tool_result arrived. One left running in the background
   * (`taskId`) only said so, so it's followed until its task ends; anything
   * else is done.
   */
  result(toolUseId: string, taskId?: string): void {
    const s = this.streams.get(toolUseId)
    if (s && taskId) s.taskId = taskId
    else this.finish(toolUseId)
  }

  /** A background task ended, or isn't among those running any more. */
  taskEnded(taskId: string): void {
    for (const s of [...this.streams.values()]) if (s.taskId === taskId) this.finish(s.toolUseId)
  }

  /** Ids of the background tasks whose commands are being followed. */
  backgroundTasks(): string[] {
    return [...this.streams.values()].flatMap((s) => (s.taskId ? [s.taskId] : []))
  }

  /** Flush and stop following a command. */
  finish(toolUseId: string): void {
    const s = this.streams.get(toolUseId)
    if (!s) return
    if (s.file) {
      this.read(s)
      for (const ext of ['.out', '.cmd']) rmSync(s.file + ext, { force: true })
    }
    if (s.taskId && s.output) this.ended.set(toolUseId, s.output)
    this.streams.delete(toolUseId)
    if (this.streams.size === 0) this.stop()
  }

  /**
   * End of turn: stop following what the turn ran and sweep logs that never
   * matched a command. Commands in the background carry on; with `all`, as
   * when the process closes, they're dropped too.
   */
  finishAll(all = false): void {
    for (const s of [...this.streams.values()]) if (all || !s.taskId) this.finish(s.toolUseId)
    const keep = new Set([...this.streams.values()].flatMap((s) => (s.file ? [s.file + '.out', s.file + '.cmd'] : [])))
    for (const name of readdirSync(STREAM_DIR)) {
      const file = join(STREAM_DIR, name)
      if (name.startsWith(this.sessionId + '.') && !keep.has(file)) rmSync(file, { force: true })
    }
  }

  /** Output so far for commands still running, and background ones that have ended, for snapshots. */
  outputs(): Record<string, string> {
    const live = [...this.streams.values()].filter((s) => s.output).map((s) => [s.toolUseId, s.output])
    return { ...Object.fromEntries(this.ended), ...Object.fromEntries(live) }
  }

  private poll(): void {
    if ([...this.streams.values()].some((s) => !s.file)) this.claim()
    for (const s of this.streams.values()) if (s.file) this.read(s)
  }

  /** Match new wrapper logs for this session to the commands we're waiting on. */
  private claim(): void {
    const claimed = new Set([...this.streams.values()].map((s) => s.file))
    for (const name of readdirSync(STREAM_DIR)) {
      if (!name.startsWith(this.sessionId + '.') || !name.endsWith('.cmd')) continue
      const file = join(STREAM_DIR, name.slice(0, -'.cmd'.length))
      if (claimed.has(file)) continue
      let shell: string
      try {
        shell = readFileSync(file + '.cmd', 'utf8')
      } catch {
        continue
      }
      const s = [...this.streams.values()].find((s) => !s.file && shell.includes(s.needle))
      if (s) {
        s.file = file
        this.onStart?.(s.toolUseId)
      }
    }
  }

  private read(s: Stream): void {
    let fd: number
    try {
      fd = openSync(s.file + '.out', 'r')
    } catch {
      return
    }
    try {
      const buf = Buffer.alloc(READ_LIMIT)
      const n = readSync(fd, buf, 0, READ_LIMIT, s.offset)
      if (n === 0) return
      s.offset += n
      const chunk = s.decoder.write(buf.subarray(0, n))
      if (!chunk) return
      s.output = (s.output + chunk).slice(-KEEP)
      this.onOutput(s.toolUseId, chunk)
    } finally {
      closeSync(fd)
    }
  }

  private stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}
