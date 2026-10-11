import type { WebSocket } from 'ws'
import { BadRequest } from './db.ts'

/**
 * One end of the connection between the hub and a runner: the runner built
 * into the hub talks over an in-memory pair, remote ones over a WebSocket.
 * Frames arrive in the order they were sent.
 */
export interface Link {
  send(frame: Frame): void
  onFrame(fn: (frame: Frame) => void): void
  onClose(fn: () => void): void
  close(): void
}

export type Frame =
  | { t: 'call'; id: number; method: string; args: unknown[] }
  /** `bad` marks an error that's the caller's fault, re-thrown as a BadRequest on their side. */
  | { t: 'reply'; id: number; result?: unknown; error?: string; bad?: boolean }
  | { t: 'event'; event: unknown }

/** Two ends of an in-process link. Frames are delivered on later ticks, like over a network, so neither side re-enters the other. */
export function memoryLinks(): [Link, Link] {
  const make = () => ({ frame: new Set<(f: Frame) => void>(), close: new Set<() => void>(), closed: false })
  const a = make()
  const b = make()
  const end = (self: typeof a, other: typeof a): Link => ({
    send: (frame) => {
      if (!self.closed) setImmediate(() => !other.closed && other.frame.forEach((fn) => fn(frame)))
    },
    onFrame: (fn) => void self.frame.add(fn),
    onClose: (fn) => void self.close.add(fn),
    close: () => {
      for (const s of [self, other]) {
        if (s.closed) continue
        s.closed = true
        s.close.forEach((fn) => fn())
      }
    },
  })
  return [end(a, b), end(b, a)]
}

/** A link over a WebSocket, one JSON frame per message. */
export function wsLink(ws: WebSocket): Link {
  return {
    send: (frame) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(frame)),
    onFrame: (fn) =>
      void ws.on('message', (raw) => {
        let frame: Frame
        try {
          frame = JSON.parse(String(raw))
        } catch {
          return
        }
        fn(frame)
      }),
    onClose: (fn) => void ws.on('close', fn),
    close: () => ws.close(),
  }
}

type Handler = (...args: any[]) => unknown

/** Every method of T, called remotely: same arguments, always a promise. */
export type Remote<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R ? (...args: A) => Promise<R extends Later<infer V> ? V : Awaited<R>> : never
}

/**
 * Calls and events over a link, both ways. Each side serves its own methods
 * and calls the other's through `remote`. A call made while the link is down
 * fails straight away; nothing is queued.
 */
export class Peer<Theirs> {
  readonly remote: Remote<Theirs>
  private next = 1
  private waiting = new Map<number, (reply: Extract<Frame, { t: 'reply' }>) => void>()
  private closed = false

  /** `methods` are served by name, but only those listed in `names`. */
  constructor(
    private link: Link,
    private methods: object,
    private names: readonly string[],
    onEvent: (event: any) => void,
    onClose: () => void = () => {},
  ) {
    link.onFrame((frame) => {
      if (frame.t === 'event') onEvent(frame.event)
      else if (frame.t === 'call') void this.serve(frame)
      else {
        const done = this.waiting.get(frame.id)
        this.waiting.delete(frame.id)
        done?.(frame)
      }
    })
    link.onClose(() => {
      this.closed = true
      for (const done of this.waiting.values()) done({ t: 'reply', id: 0, error: 'Disconnected' })
      this.waiting.clear()
      onClose()
    })
    this.remote = new Proxy({} as Remote<Theirs>, {
      get: (_, method) => (typeof method === 'string' ? (...args: unknown[]) => this.call(method, args) : undefined),
    })
  }

  call(method: string, args: unknown[]): Promise<any> {
    return new Promise((resolve, reject) => this.request(method, args, (err, result) => (err ? reject(err) : resolve(result))))
  }

  /**
   * A call whose reply is handled synchronously, in order with the frames
   * around it. A promise would run its callback a tick later, after frames
   * that arrived just behind the reply, e.g. terminal output that the reply's
   * snapshot doesn't include.
   */
  request(method: string, args: unknown[], done: (err: Error | null, result?: any) => void): void {
    if (this.closed) return done(new Error('Disconnected'))
    const id = this.next++
    this.waiting.set(id, (r) => done(r.error === undefined ? null : r.bad ? new BadRequest(r.error) : new Error(r.error), r.result))
    this.link.send({ t: 'call', id, method, args })
  }

  emit(event: unknown): void {
    if (!this.closed) this.link.send({ t: 'event', event })
  }

  close(): void {
    this.link.close()
  }

  private async serve(frame: Extract<Frame, { t: 'call' }>): Promise<void> {
    const fn = this.names.includes(frame.method) ? (this.methods as Record<string, Handler>)[frame.method] : undefined
    const fail = (err: unknown) =>
      this.link.send({ t: 'reply', id: frame.id, error: err instanceof Error ? err.message : String(err), bad: err instanceof BadRequest })
    try {
      if (typeof fn !== 'function') throw new BadRequest(`Unknown method: ${frame.method}`)
      const result = fn.apply(this.methods, frame.args)
      if (result instanceof Later) return result.settle((err, value) => (err ? fail(err) : this.link.send({ t: 'reply', id: frame.id, result: value })))
      this.link.send({ t: 'reply', id: frame.id, result: await result })
    } catch (err) {
      fail(err)
    }
  }
}

/**
 * A result a method hands back later, from a callback, with the reply sent the
 * moment it's settled rather than a tick after: so it's ordered with whatever
 * the method's side sends next.
 */
export class Later<T> {
  constructor(private start: (settle: (err: Error | null, value?: T) => void) => void) {}

  settle(fn: (err: Error | null, value?: T) => void): void {
    this.start(fn)
  }
}
