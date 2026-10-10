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
}

export class BashStreams {
  private streams = new Map<string, Stream>()
  private timer: NodeJS.Timeout | null = null

  constructor(
    private sessionId: string,
    private onOutput: (toolUseId: string, chunk: string) => void,
  ) {}

  /** Called from the PreToolUse hook, before the command runs (or is approved). */
  track(toolUseId: string, command: string): void {
    this.streams.set(toolUseId, { toolUseId, needle: evalForm(command), offset: 0, decoder: new StringDecoder('utf8'), output: '' })
    this.timer ??= setInterval(() => this.poll(), POLL_MS)
  }

  /** Flush and stop following a command once its tool_result arrives. */
  finish(toolUseId: string): void {
    const s = this.streams.get(toolUseId)
    if (!s) return
    if (s.file) {
      this.read(s)
      for (const ext of ['.out', '.cmd']) rmSync(s.file + ext, { force: true })
    }
    this.streams.delete(toolUseId)
    if (this.streams.size === 0) this.stop()
  }

  /** End of turn: stop everything and sweep logs that never matched a command. */
  finishAll(): void {
    for (const id of [...this.streams.keys()]) this.finish(id)
    for (const name of readdirSync(STREAM_DIR)) {
      if (name.startsWith(this.sessionId + '.')) rmSync(join(STREAM_DIR, name), { force: true })
    }
  }

  /** Output so far for commands still running, for snapshots. */
  outputs(): Record<string, string> {
    return Object.fromEntries([...this.streams.values()].filter((s) => s.output).map((s) => [s.toolUseId, s.output]))
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
      if (s) s.file = file
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
