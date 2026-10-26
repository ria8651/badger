import type { Socket } from 'node:net'
import type { WebSocket } from 'ws'
import type { ZodType } from 'zod'
import { BadRequest, message } from './errors.ts'

/**
 * One end of a connection between two Peers. The hub and its own runner talk
 * over an in-memory pair, remote runners over a WebSocket, the PTY host over
 * a unix socket. Frames arrive in the order they were sent.
 */
export interface Link {
  send(frame: Frame): void
  onFrame(fn: (frame: Frame) => void): void
  onClose(fn: () => void): void
  /** `now` drops the connection without the closing handshake, so nothing more comes in on it. */
  close(now?: boolean): void
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

/**
 * A link over a WebSocket, one JSON frame per message. With `pingMs`, the
 * other end is pinged that often, and the connection dropped if it hasn't
 * answered the last ping by the next: a laptop gone to sleep can leave it
 * half-open, answering nothing.
 */
export function wsLink(ws: WebSocket, opts: { pingMs?: number } = {}): Link {
  if (opts.pingMs) {
    let alive = true
    ws.on('pong', () => (alive = true))
    const ping = setInterval(() => {
      if (!alive) return ws.terminate()
      alive = false
      ws.ping()
    }, opts.pingMs)
    ws.on('close', () => clearInterval(ping))
  }
  // Errors, e.g. a frame over maxPayload, end in a close, which is what's listened for. Unheard, one would crash the process.
  ws.on('error', () => {})
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
    close: (now) => (now ? ws.terminate() : ws.close()),
  }
}

/** Frames as another protocol's messages, for a link that speaks it. */
export interface Codec {
  encode(frame: Frame): unknown
  /** Undefined for a message that isn't a frame, which is dropped. */
  decode(message: any): Frame | undefined
}

/** A link over a stream socket, one JSON message per line: frames, or with a codec, what it makes of them. */
export function ndjsonLink(socket: Socket, codec?: Codec): Link {
  const listeners = new Set<(frame: Frame) => void>()
  let buf = ''
  socket.setEncoding('utf8')
  socket.on('data', (chunk: string) => {
    buf += chunk
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      let frame: Frame | undefined
      try {
        const message = JSON.parse(line)
        frame = codec ? codec.decode(message) : message
      } catch {
        continue
      }
      if (frame) for (const fn of listeners) fn(frame)
    }
  })
  // Errors end in a close, which is what's listened for.
  socket.on('error', () => {})
  return {
    send: (frame) => void (!socket.destroyed && socket.write(JSON.stringify(codec ? codec.encode(frame) : frame) + '\n')),
    onFrame: (fn) => void listeners.add(fn),
    onClose: (fn) => void socket.on('close', fn),
    close: (now) => void (now ? socket.destroy() : socket.end()),
  }
}

type Handler = (...args: any[]) => unknown

/**
 * The methods one side serves: just their names, or for a side that doesn't
 * trust its caller, a schema of each one's arguments. Calls whose arguments
 * don't match are refused, and so are methods that aren't listed.
 */
export type Served = readonly string[] | Readonly<Record<string, ZodType<unknown[]>>>

/** For a side that doesn't trust the other's answers: a schema of what each method returns. Methods that aren't listed are taken as they come. */
export type Replies = Readonly<Record<string, ZodType>>

/** Every method of T, called remotely: same arguments, always a promise. */
export type Remote<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R ? (...args: A) => Promise<R extends Later<infer V> ? V : Awaited<R>> : never
}

/** A Remote whose every method goes through `call`. It has no `then`, so it can be awaited or returned from an async function as itself. */
export function remote<T>(call: (method: string, args: unknown[]) => Promise<any>): Remote<T> {
  return new Proxy({} as Remote<T>, {
    get: (_, method) => (typeof method === 'string' && method !== 'then' ? (...args: unknown[]) => call(method, args) : undefined),
  })
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

  /**
   * `methods` are served by name, but only those listed in `served`. A side
   * that doesn't trust the other also checks its replies against
   * `opts.replies`, and gives up on every call after `opts.timeoutMs`, so one
   * that never answers can't pile them up.
   */
  constructor(
    private link: Link,
    private methods: object,
    private served: Served,
    onEvent: (event: any) => void,
    onClose: () => void = () => {},
    private opts: { replies?: Replies; timeoutMs?: number } = {},
  ) {
    link.onFrame((frame) => {
      // Nothing the other side sends may throw out of here: it would take the whole process down.
      try {
        if (typeof frame !== 'object' || frame === null) return
        if (frame.t === 'event') onEvent(frame.event)
        else if (frame.t === 'call') void this.serve(frame)
        else if (frame.t === 'reply') {
          const done = this.waiting.get(frame.id)
          this.waiting.delete(frame.id)
          done?.(frame)
        }
      } catch (err) {
        console.error('Handling a frame failed:', err)
      }
    })
    link.onClose(() => {
      this.closed = true
      for (const done of this.waiting.values()) done({ t: 'reply', id: 0, error: 'Disconnected' })
      this.waiting.clear()
      onClose()
    })
    this.remote = remote((method, args) => this.call(method, args))
  }

  call(method: string, args: unknown[], timeoutMs?: number): Promise<any> {
    return new Promise((resolve, reject) => this.request(method, args, (err, result) => (err ? reject(err) : resolve(result)), timeoutMs))
  }

  /**
   * The other side's methods, giving up on any reply that takes longer than
   * this. Only for quick questions someone is waiting on: a half-open
   * connection (a laptop gone to sleep) answers nothing until the ping drops
   * it. Calls that send a lot, or take a while to do, go through `remote`.
   */
  within(ms: number): Remote<Theirs> {
    return remote((method, args) => this.call(method, args, ms))
  }

  /**
   * A call whose reply is handled synchronously, in order with the frames
   * around it. A promise would run its callback a tick later, after frames
   * that arrived just behind the reply, e.g. terminal output that the reply's
   * snapshot doesn't include.
   */
  request(method: string, args: unknown[], done: (err: Error | null, result?: any) => void, timeoutMs = this.opts.timeoutMs): void {
    if (this.closed) return done(new Error('Disconnected'))
    const replies = this.opts.replies
    const schema = replies && Object.hasOwn(replies, method) ? replies[method] : undefined
    const id = this.next++
    // A reply after this is dropped: it's no longer waited for.
    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            this.waiting.delete(id)
            done(new Error(`No answer to ${method} in ${timeoutMs / 1000}s`))
          }, timeoutMs)
    this.waiting.set(id, (r) => {
      clearTimeout(timer)
      if (r.error !== undefined) return done(r.bad ? new BadRequest(String(r.error)) : new Error(String(r.error)))
      if (!schema) return done(null, r.result)
      const parsed = schema.safeParse(r.result)
      done(parsed.success ? null : new Error(`Bad answer to ${method}: ${parsed.error.issues[0]?.message ?? 'invalid'}`), parsed.data)
    })
    this.link.send({ t: 'call', id, method, args })
  }

  emit(event: unknown): void {
    if (!this.closed) this.link.send({ t: 'event', event })
  }

  close(now = false): void {
    this.link.close(now)
  }

  /** The call's arguments, if the method is served and they're what it takes. */
  private argsFor(method: string, args: unknown): unknown[] {
    if (Array.isArray(this.served)) {
      if (!this.served.includes(method)) throw new BadRequest(`Unknown method: ${method}`)
      return Array.isArray(args) ? args : []
    }
    const schema = Object.hasOwn(this.served, method) ? (this.served as Record<string, ZodType<unknown[]>>)[method] : undefined
    if (!schema) throw new BadRequest(`Unknown method: ${method}`)
    const parsed = schema.safeParse(args)
    if (!parsed.success) throw new BadRequest(`Bad arguments to ${method}: ${parsed.error.issues[0]?.message ?? 'invalid'}`)
    return parsed.data
  }

  private async serve(frame: Extract<Frame, { t: 'call' }>): Promise<void> {
    const fail = (err: unknown) => this.link.send({ t: 'reply', id: frame.id, error: message(err), bad: err instanceof BadRequest })
    try {
      const args = this.argsFor(String(frame.method), frame.args)
      const fn = (this.methods as Record<string, Handler>)[frame.method]
      if (typeof fn !== 'function') throw new BadRequest(`Unknown method: ${frame.method}`)
      const result = fn.apply(this.methods, args)
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
