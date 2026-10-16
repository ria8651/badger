import { spawn } from 'node:child_process'
import { closeSync, existsSync, openSync } from 'node:fs'
import { homedir } from 'node:os'
import { connect, type Socket } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { TerminalInfo } from '../shared/protocol.ts'
import { listeningPorts } from './ports.ts'
import { PTY_HOST_VERSION, type CreateSpec, type HostEvent, type HostRequest } from './ptyProtocol.ts'

const HOST_SCRIPT = fileURLToPath(new URL('./ptyHost.ts', import.meta.url))

export type TerminalEvent = { type: 'terminals'; terminals: TerminalInfo[] } | { type: 'output'; id: string; data: string }

type Reply = { result?: unknown; error?: string }

/** How often running terminals are checked for ports they listen on. */
const PORTS_POLL_MS = 2000

/**
 * The server's connection to the PTY host (server/ptyHost.ts), starting the
 * host when there isn't one. Terminals live in the host, so restarting the
 * server leaves them running; on reconnect the host sends them back.
 */
export class Terminals {
  terminals: TerminalInfo[] = []
  /** False until the first host says hello. Before then the list is unknown, not empty. */
  known = false
  private socket: Socket | null = null
  private ready: Promise<Socket> | null = null
  private listeners = new Set<(e: TerminalEvent) => void>()
  private pending = new Map<number, (reply: Reply) => void>()
  private nextReq = 1
  private greeted = () => {}
  /** The host runs older code than this server, so may not know every request. */
  private outdated = false
  /** Set while an outdated host with no terminals is shutting down so a current one can replace it. */
  private replacing = false
  private readonly socketPath: string
  /** What each running terminal listens on; the host doesn't know, so it's added to its list here. */
  private ports = new Map<string, number[]>()

  constructor(
    private dataDir: string,
    /** Environment for the host and so every terminal: the user's shell, minus what pnpm and Badger add. */
    private env: NodeJS.ProcessEnv,
  ) {
    this.socketPath = join(dataDir, 'pty.sock')
    setInterval(() => void this.pollPorts(), PORTS_POLL_MS).unref()
  }

  /** Listeners run synchronously, in the order the host sent things. */
  on(listener: (e: TerminalEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  get(id: string): TerminalInfo | undefined {
    return this.terminals.find((t) => t.id === id)
  }

  connect(): Promise<Socket> {
    this.ready ??= this.open().catch((err) => {
      this.ready = null
      throw err
    })
    return this.ready
  }

  // The host's list broadcasts are throttled; take what a reply says straight away so callers can rely on get().
  async create(spec: CreateSpec): Promise<TerminalInfo> {
    return this.upsert((await this.call((reqId) => ({ type: 'create', reqId, spec }))) as TerminalInfo)
  }

  async stop(id: string): Promise<TerminalInfo> {
    return this.upsert((await this.call((reqId) => ({ type: 'stop', reqId, id }))) as TerminalInfo)
  }

  async restart(id: string): Promise<TerminalInfo> {
    return this.upsert((await this.call((reqId) => ({ type: 'restart', reqId, id }))) as TerminalInfo)
  }

  async rename(id: string, name?: string): Promise<TerminalInfo> {
    await this.connect()
    // An older host never answers a request it doesn't know.
    if (this.outdated) throw new Error('Terminals here run on older code that can’t rename them. Close them all to update it.')
    return this.upsert((await this.call((reqId) => ({ type: 'rename', reqId, id, name }))) as TerminalInfo)
  }

  async remove(id: string): Promise<void> {
    await this.call((reqId) => ({ type: 'remove', reqId, id }))
    this.terminals = this.terminals.filter((t) => t.id !== id)
  }

  private upsert(info: TerminalInfo): TerminalInfo {
    info = this.withPorts(info)
    const i = this.terminals.findIndex((t) => t.id === info.id)
    this.terminals = i < 0 ? [...this.terminals, info] : this.terminals.with(i, info)
    return info
  }

  private withPorts = (t: TerminalInfo): TerminalInfo => {
    const ports = t.running ? this.ports.get(t.id) : undefined
    return ports ? { ...t, ports } : { ...t, ports: undefined }
  }

  private polling = false
  private async pollPorts(): Promise<void> {
    const running = this.terminals.filter((t) => t.running && t.pid)
    if (this.polling || (!running.length && !this.ports.size)) return
    this.polling = true
    try {
      const byPid = await listeningPorts(running.map((t) => t.pid!))
      const next = new Map<string, number[]>()
      for (const t of running) if (byPid.has(t.pid!)) next.set(t.id, byPid.get(t.pid!)!)
      const key = (m: Map<string, number[]>) => JSON.stringify([...m].sort())
      if (key(next) === key(this.ports)) return
      this.ports = next
      this.terminals = this.terminals.map(this.withPorts)
      this.emit({ type: 'terminals', terminals: this.terminals })
    } catch (err) {
      console.error('Checking terminal ports failed:', err instanceof Error ? err.message : err)
    } finally {
      this.polling = false
    }
  }

  /** Plain text of the last `lines` lines on screen. */
  text(id: string, lines: number): Promise<string> {
    return this.call((reqId) => ({ type: 'text', reqId, id, lines })) as Promise<string>
  }

  /**
   * The screen as escape sequences. The callback runs synchronously in stream
   * order: output emitted before it is already in the snapshot, output after
   * it is not.
   */
  snapshot(id: string, done: (data: string | undefined) => void): void {
    if (!this.socket) return void this.connect().then(() => (this.socket ? this.snapshot(id, done) : done(undefined)), () => done(undefined))
    const reqId = this.nextReq++
    this.pending.set(reqId, (r) => done(r.error ? undefined : (r.result as string)))
    this.write({ type: 'snapshot', reqId, id })
  }

  input(id: string, data: string): void {
    this.write({ type: 'input', id, data })
  }

  resize(id: string, cols: number, rows: number): void {
    this.write({ type: 'resize', id, cols, rows })
  }

  private async call(build: (reqId: number) => HostRequest): Promise<unknown> {
    await this.connect()
    // It can drop between connecting and here; a request written to nothing would never be answered.
    if (!this.socket) throw new Error('PTY host disconnected')
    const reqId = this.nextReq++
    return new Promise((resolve, reject) => {
      this.pending.set(reqId, (r) => (r.error ? reject(new Error(r.error)) : resolve(r.result)))
      this.write(build(reqId))
    })
  }

  private write(req: HostRequest): void {
    this.socket?.write(JSON.stringify(req) + '\n')
  }

  private emit(event: TerminalEvent): void {
    for (const l of this.listeners) l(event)
  }

  /** Connect to a running host, or start one and wait for it to listen. */
  private async open(): Promise<Socket> {
    let socket = await this.dial().catch(() => null)
    if (!socket) {
      this.spawnHost()
      for (let i = 0; !socket && i < 50; i++) {
        await new Promise((r) => setTimeout(r, 100))
        socket = await this.dial().catch(() => null)
      }
      if (!socket) throw new Error(`PTY host did not start; see ${join(this.dataDir, 'pty-host.log')}`)
    }
    try {
      return await this.attach(socket)
    } catch (err) {
      if (!this.replacing) throw err
      // The outdated host removes its socket as it exits; then start a current one.
      this.replacing = false
      for (let i = 0; existsSync(this.socketPath) && i < 20; i++) await new Promise((r) => setTimeout(r, 100))
      return this.open()
    }
  }

  private dial(): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const s = connect(this.socketPath)
      s.once('connect', () => resolve(s))
      s.once('error', reject)
    })
  }

  private spawnHost(): void {
    const log = openSync(join(this.dataDir, 'pty-host.log'), 'a')
    // Detached into its own session so it survives this server, and Ctrl-C in the terminal that ran it.
    const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), HOST_SCRIPT, this.socketPath], {
      detached: true,
      stdio: ['ignore', log, log],
      env: this.env,
      cwd: homedir(),
    })
    child.unref()
    closeSync(log)
  }

  /** Resolves once the host has said hello, so the terminal list is filled in. */
  private attach(socket: Socket): Promise<Socket> {
    this.socket = socket
    const hello = new Promise<Socket>((resolve, reject) => {
      this.greeted = () => resolve(socket)
      socket.once('close', () => reject(new Error('PTY host closed the connection')))
    })
    socket.setEncoding('utf8')
    let buf = ''
    socket.on('data', (chunk: string) => {
      buf += chunk
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        try {
          this.handle(JSON.parse(line) as HostEvent)
        } catch (err) {
          console.error('PTY host message failed:', err)
        }
      }
    })
    socket.on('error', () => {})
    socket.on('close', () => {
      if (this.socket !== socket) return
      this.socket = null
      this.ready = null
      for (const done of this.pending.values()) done({ error: 'PTY host disconnected' })
      this.pending.clear()
      // open() is already replacing it.
      if (this.replacing) return
      // The host died (it never exits while we're connected); start another so terminals can be opened again.
      // The list stays as it was until the new host says hello, rather than telling every browser there are none.
      setTimeout(() => this.connect().catch((err) => console.error(err.message)), 1000)
    })
    return hello
  }

  private handle(event: HostEvent): void {
    switch (event.type) {
      case 'hello':
        this.outdated = event.version < PTY_HOST_VERSION
        if (event.version !== PTY_HOST_VERSION) {
          if (event.terminals.length === 0) {
            this.replacing = true
            this.write({ type: 'shutdown' })
            return
          }
          console.warn(
            `PTY host ${event.pid} runs protocol v${event.version}, this server v${PTY_HOST_VERSION}. Close all terminals (or kill ${event.pid}) to update it.`,
          )
        }
        this.terminals = event.terminals.map(this.withPorts)
        this.known = true
        this.emit({ type: 'terminals', terminals: this.terminals })
        this.greeted()
        return
      case 'terminals':
        this.terminals = event.terminals.map(this.withPorts)
        this.emit({ type: 'terminals', terminals: this.terminals })
        return
      case 'output':
        this.emit(event)
        return
      case 'reply': {
        const done = this.pending.get(event.reqId)
        this.pending.delete(event.reqId)
        done?.(event)
        return
      }
    }
  }
}

/** Drops what running under pnpm and Badger adds, so terminals behave like the user's own. */
export function shellEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(env)) {
    if (/^(npm_|PNPM_|CLAUDE_CODE_|CLAUDECODE$|INIT_CWD$|FORCE_COLOR$|NODE$|COLUMNS$|LINES$)/.test(key)) continue
    clean[key] = value
  }
  // pnpm puts this project's node_modules/.bin dirs at the front of PATH.
  clean.PATH = env.PATH?.split(':')
    .filter((p) => !/\/node_modules\/(\.bin|\.pnpm\/)|node-gyp-bin/.test(p))
    .join(':')
  return clean
}
