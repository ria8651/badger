import { spawn } from 'node:child_process'
import { closeSync, existsSync, openSync } from 'node:fs'
import { homedir } from 'node:os'
import { connect, type Socket } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { TerminalInfo } from '../shared/protocol.ts'
import { message } from './errors.ts'
import { Peer, ndjsonLink, type Remote } from './peer.ts'
import { listeningPorts } from './ports.ts'
import { PTY_HOST_VERSION, PTY_WIRE, type CreateSpec, type HostCommand, type HostEvent, type PtyHostApi } from './ptyProtocol.ts'

const HOST_SCRIPT = fileURLToPath(new URL('./ptyHost.ts', import.meta.url))

export type TerminalEvent = { type: 'terminals'; terminals: TerminalInfo[] } | { type: 'output'; id: string; data: string }

/** How often running terminals are checked for ports they listen on. */
const PORTS_POLL_MS = 2000
/** The longest a request to the host is waited on. A host on older code never answers one it doesn't know. */
const CALL_TIMEOUT_MS = 60 * 1000

/**
 * The server's connection to the PTY host (server/ptyHost.ts), starting the
 * host when there isn't one. Terminals live in the host, so restarting the
 * server leaves them running; on reconnect the host sends them back.
 */
export class Terminals {
  private list: TerminalInfo[] = []
  private greeted = false
  private host: Peer<PtyHostApi> | null = null
  private ready: Promise<Peer<PtyHostApi>> | null = null
  private listeners = new Set<(e: TerminalEvent) => void>()
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

  /** Every terminal, as the host last said, with the ports each listens on. */
  get terminals(): TerminalInfo[] {
    return this.list
  }

  /** False until the first host says hello. Before then the list is unknown, not empty. */
  get known(): boolean {
    return this.greeted
  }

  /** Listeners run synchronously, in the order the host sent things. */
  on(listener: (e: TerminalEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  get(id: string): TerminalInfo | undefined {
    return this.list.find((t) => t.id === id)
  }

  /** Resolves once a host has said hello, starting one if there isn't one. */
  connect(): Promise<Peer<PtyHostApi>> {
    this.ready ??= this.open().catch((err) => {
      this.ready = null
      throw err
    })
    return this.ready
  }

  // The host's list broadcasts are throttled; take what a reply says straight away so callers can rely on get().
  async create(spec: CreateSpec): Promise<TerminalInfo> {
    return this.upsert(await (await this.call()).create(spec))
  }

  async stop(id: string): Promise<TerminalInfo> {
    return this.upsert(await (await this.call()).stop(id))
  }

  async restart(id: string): Promise<TerminalInfo> {
    return this.upsert(await (await this.call()).restart(id))
  }

  async rename(id: string, name?: string): Promise<TerminalInfo> {
    const host = await this.call()
    // An older host never answers a request it doesn't know.
    if (this.outdated) throw new Error('Terminals here run on older code that can’t rename them. Close them all to update it.')
    return this.upsert(await host.rename(id, name))
  }

  async remove(id: string): Promise<void> {
    await (await this.call()).remove(id)
    this.list = this.list.filter((t) => t.id !== id)
  }

  /** Plain text of the last `lines` lines on screen. */
  async text(id: string, lines: number): Promise<string> {
    return (await this.call()).text(id, lines)
  }

  /**
   * The screen as escape sequences. The callback runs synchronously in stream
   * order: output emitted before it is already in the snapshot, output after
   * it is not.
   */
  snapshot(id: string, done: (data: string | undefined) => void): void {
    if (!this.host) return void this.connect().then(() => (this.host ? this.snapshot(id, done) : done(undefined)), () => done(undefined))
    this.host.request('snapshot', [id], (err, data) => done(err ? undefined : data))
  }

  input(id: string, data: string): void {
    this.command({ type: 'input', id, data })
  }

  resize(id: string, cols: number, rows: number): void {
    this.command({ type: 'resize', id, cols, rows })
  }

  /** The host, once it has said hello. A call made after it drops fails at once rather than waiting. */
  private async call(): Promise<Remote<PtyHostApi>> {
    return (await this.connect()).remote
  }

  private command(command: HostCommand): void {
    this.host?.emit(command)
  }

  private upsert(info: TerminalInfo): TerminalInfo {
    info = this.withPorts(info)
    const i = this.list.findIndex((t) => t.id === info.id)
    this.list = i < 0 ? [...this.list, info] : this.list.with(i, info)
    return info
  }

  private withPorts = (t: TerminalInfo): TerminalInfo => {
    const ports = t.running ? this.ports.get(t.id) : undefined
    return ports ? { ...t, ports } : { ...t, ports: undefined }
  }

  private polling = false
  private async pollPorts(): Promise<void> {
    const running = this.list.filter((t) => t.running && t.pid)
    if (this.polling || (!running.length && !this.ports.size)) return
    this.polling = true
    try {
      const byPid = await listeningPorts(running.map((t) => t.pid!))
      const next = new Map<string, number[]>()
      for (const t of running) if (byPid.has(t.pid!)) next.set(t.id, byPid.get(t.pid!)!)
      const key = (m: Map<string, number[]>) => JSON.stringify([...m].sort())
      if (key(next) === key(this.ports)) return
      this.ports = next
      this.setList(this.list)
    } catch (err) {
      console.error('Checking terminal ports failed:', message(err))
    } finally {
      this.polling = false
    }
  }

  private setList(terminals: TerminalInfo[]): void {
    this.list = terminals.map(this.withPorts)
    this.emit({ type: 'terminals', terminals: this.list })
  }

  private emit(event: TerminalEvent): void {
    for (const l of this.listeners) l(event)
  }

  /** Connect to a running host, or start one and wait for it to listen. */
  private async open(): Promise<Peer<PtyHostApi>> {
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
  private attach(socket: Socket): Promise<Peer<PtyHostApi>> {
    return new Promise((resolve, reject) => {
      const host: Peer<PtyHostApi> = new Peer<PtyHostApi>(
        ndjsonLink(socket, PTY_WIRE),
        {},
        [],
        (event: HostEvent) => {
          if (event.type !== 'hello') return this.handle(event)
          this.outdated = event.version < PTY_HOST_VERSION
          if (event.version !== PTY_HOST_VERSION) {
            if (event.terminals.length === 0) {
              this.replacing = true
              host.emit({ type: 'shutdown' } satisfies HostCommand)
              return
            }
            console.warn(
              `PTY host ${event.pid} runs protocol v${event.version}, this server v${PTY_HOST_VERSION}. Close all terminals (or kill ${event.pid}) to update it.`,
            )
          }
          this.greeted = true
          this.setList(event.terminals)
          resolve(host)
        },
        () => {
          reject(new Error('PTY host closed the connection'))
          if (this.host !== host) return
          this.host = null
          this.ready = null
          // open() is already replacing it.
          if (this.replacing) return
          // The host died (it never exits while we're connected); start another so terminals can be opened again.
          // The list stays as it was until the new host says hello, rather than telling every browser there are none.
          setTimeout(() => this.connect().catch((err) => console.error(err.message)), 1000)
        },
        { timeoutMs: CALL_TIMEOUT_MS },
      )
      this.host = host
    })
  }

  private handle(event: Exclude<HostEvent, { type: 'hello' }>): void {
    if (event.type === 'terminals') this.setList(event.terminals)
    else if (event.type === 'output') this.emit(event)
  }
}
