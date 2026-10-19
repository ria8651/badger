import type { TerminalInfo } from '../shared/protocol.ts'
import type { Codec, Frame, Later } from './peer.ts'

/**
 * Between the Badger server and the PTY host: a Peer over newline-delimited
 * JSON on a unix socket. The host outlives server restarts, so a server can
 * meet a host started by older code; bump this when the messages or the
 * host's behaviour change, and the server replaces an outdated host once it
 * has no terminals.
 */
export const PTY_HOST_VERSION = 4

export interface CreateSpec {
  cwd: string
  command?: string
  /** Defaults to the shell's numbered name for a shell, and none (so the command shows) for a command. */
  name?: string
  sessionId?: string
  cols?: number
  rows?: number
}

/** Methods the host serves. */
export interface PtyHostApi {
  create(spec: CreateSpec): TerminalInfo
  /** Kills its process, keeping the terminal and its output. */
  stop(id: string): Promise<TerminalInfo>
  restart(id: string): Promise<TerminalInfo>
  /** No name, or a blank one, puts the default back. */
  rename(id: string, name?: string): TerminalInfo
  remove(id: string): Promise<void>
  /** The screen as escape sequences, settled in order with its output: what came before is in it, what comes after isn't. */
  snapshot(id: string): Later<string>
  /** Plain text of the last `lines` lines on screen. */
  text(id: string, lines: number): Later<string>
}

/** Server to host, unasked: keystrokes and the like, which don't wait for an answer. */
export type HostCommand =
  | { type: 'input'; id: string; data: string }
  | { type: 'resize'; id: string; cols: number; rows: number }
  /** Only sent when the host has no terminals, to replace an outdated one. */
  | { type: 'shutdown' }

/** Host to server, unasked. */
export type HostEvent =
  | { type: 'hello'; version: number; pid: number; terminals: TerminalInfo[] }
  | { type: 'terminals'; terminals: TerminalInfo[] }
  /** Sent once the host's screen has taken the data in, so it is ordered with snapshots. */
  | { type: 'output'; id: string; data: string }

/** Each method's arguments by name, which is how they go on the wire; and every method the host serves. */
const ARGS = {
  create: ['spec'],
  stop: ['id'],
  restart: ['id'],
  rename: ['id', 'name'],
  remove: ['id'],
  snapshot: ['id'],
  text: ['id', 'lines'],
} as const satisfies { [K in keyof PtyHostApi]: readonly string[] }

export const PTY_METHODS = Object.keys(ARGS) as (keyof PtyHostApi)[]

/**
 * Peer frames as the host protocol has always put them, so a server and a
 * host on different code still understand each other: a call is a message
 * named after its method, with its arguments by name and a `reqId`; a reply
 * is a `reply` with that `reqId`; an event is just the event.
 */
export const PTY_WIRE: Codec = {
  encode: (frame) => {
    if (frame.t === 'event') return frame.event
    if (frame.t === 'reply') return { type: 'reply', reqId: frame.id, result: frame.result, error: frame.error }
    const names: readonly string[] = Object.hasOwn(ARGS, frame.method) ? ARGS[frame.method as keyof PtyHostApi] : []
    return { type: frame.method, reqId: frame.id, ...Object.fromEntries(names.map((n, i) => [n, frame.args[i]])) }
  },
  decode: (m): Frame | undefined => {
    if (typeof m !== 'object' || m === null || typeof m.type !== 'string') return undefined
    if (m.type === 'reply') return { t: 'reply', id: m.reqId, result: m.result, error: m.error }
    if (typeof m.reqId !== 'number') return { t: 'event', event: m }
    const names: readonly string[] = Object.hasOwn(ARGS, m.type) ? ARGS[m.type as keyof PtyHostApi] : []
    return { t: 'call', id: m.reqId, method: m.type, args: names.map((n) => m[n]) }
  },
}
