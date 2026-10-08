import type { TerminalInfo } from '../shared/protocol.ts'

/**
 * Between the Badger server and the PTY host: newline-delimited JSON over a
 * unix socket. The host outlives server restarts, so a server can meet a host
 * started by older code; bump this when the messages or the host's behaviour
 * change, and the server replaces an outdated host once it has no terminals.
 */
export const PTY_HOST_VERSION = 2

export interface CreateSpec {
  cwd: string
  command?: string
  sessionId?: string
  cols?: number
  rows?: number
}

export type HostRequest =
  | { type: 'create'; reqId: number; spec: CreateSpec }
  | { type: 'input'; id: string; data: string }
  | { type: 'resize'; id: string; cols: number; rows: number }
  | { type: 'stop'; reqId: number; id: string }
  | { type: 'restart'; reqId: number; id: string }
  | { type: 'remove'; reqId: number; id: string }
  | { type: 'snapshot'; reqId: number; id: string }
  | { type: 'text'; reqId: number; id: string; lines: number }
  /** Only sent when the host has no terminals, to replace an outdated one. */
  | { type: 'shutdown' }

export type HostEvent =
  | { type: 'hello'; version: number; pid: number; terminals: TerminalInfo[] }
  | { type: 'terminals'; terminals: TerminalInfo[] }
  /** Sent once the host's screen has taken the data in, so it is ordered with snapshots. */
  | { type: 'output'; id: string; data: string }
  | { type: 'reply'; reqId: number; result?: unknown; error?: string }
