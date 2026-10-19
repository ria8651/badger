/**
 * Owns every terminal's PTY in a process of its own, so shells and dev servers
 * survive Badger server restarts. server/terminals.ts starts it detached and
 * talks to it over a unix socket; it exits once it has neither terminals nor a
 * server connected. A headless xterm per terminal tracks the screen, so a
 * viewer that (re)attaches gets an exact repaint and Claude can read the
 * output as plain text.
 *
 * Usage: node --import tsx server/ptyHost.ts <socket path>
 */
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, statSync, unlinkSync } from 'node:fs'
import { connect, createServer, type Socket } from 'node:net'
import { basename } from 'node:path'
import headless from '@xterm/headless'
import serialize from '@xterm/addon-serialize'
import { spawn, type IPty } from '@lydell/node-pty'
import type { TerminalInfo } from '../shared/protocol.ts'
import { message } from './errors.ts'
import { alive, descendants, signal } from './proc.ts'
import { PTY_HOST_VERSION, type CreateSpec, type HostEvent, type HostRequest } from './ptyProtocol.ts'
import { workspaceRoot } from './workspace.ts'

const { Terminal } = headless
const { SerializeAddon } = serialize
type Screen = InstanceType<typeof Terminal>

const SOCKET = process.argv[2]
const SCROLLBACK = 5000
/** How long a stopped process gets after SIGHUP/SIGTERM before SIGKILL. */
const KILL_GRACE_MS = 3000
/** How long after SIGKILL to wait for node-pty to report the exit before treating it as gone. */
const EXIT_WAIT_MS = 2000
const IDLE_EXIT_MS = 10_000
const SHELL = process.env.SHELL || '/bin/bash'

if (!SOCKET) {
  console.error('usage: ptyHost.ts <socket path>')
  process.exit(2)
}

interface Term {
  info: TerminalInfo
  pty: IPty | null
  screen: Screen
  serializer: InstanceType<typeof SerializeAddon>
  cols: number
  rows: number
  /** Set while stopping on purpose, so a shell that exits isn't removed mid-restart. */
  keep: boolean
  /** Stop, restart and remove run one at a time per terminal; this is the tail of that queue. */
  ops: Promise<unknown>
}

const terms = new Map<string, Term>()
const clients = new Set<Socket>()

function send(client: Socket, event: HostEvent): void {
  if (!client.destroyed) client.write(JSON.stringify(event) + '\n')
}

function broadcast(event: HostEvent): void {
  for (const c of clients) send(c, event)
}

const list = () => [...terms.values()].map((t) => t.info)

// Programs can retitle many times a second; tell servers at most every 100ms.
let changeTimer: NodeJS.Timeout | null = null
function changed(): void {
  changeTimer ??= setTimeout(() => {
    changeTimer = null
    broadcast({ type: 'terminals', terminals: list() })
  }, 100)
}

function create(spec: CreateSpec): TerminalInfo {
  if (!existsSync(spec.cwd) || !statSync(spec.cwd).isDirectory()) throw new Error(`No such directory: ${spec.cwd}`)
  const cols = clamp(spec.cols ?? 120, 2, 1000)
  const rows = clamp(spec.rows ?? 30, 2, 500)
  const screen = new Terminal({ cols, rows, scrollback: SCROLLBACK, allowProposedApi: true })
  const serializer = new SerializeAddon()
  screen.loadAddon(serializer)
  const root = workspaceRoot(spec.cwd)
  const t: Term = {
    info: {
      id: randomBytes(4).toString('hex'),
      title: spec.command ?? basename(SHELL),
      name: defaultName(root, spec.command, spec.name),
      cwd: spec.cwd,
      root,
      command: spec.command,
      sessionId: spec.sessionId,
      running: false,
      createdAt: Date.now(),
    },
    pty: null,
    screen,
    serializer,
    cols,
    rows,
    keep: false,
    ops: Promise.resolve(),
  }
  // The screen answers the program's terminal queries (device attributes, cursor position, modes). It's
  // always here, unlike a browser, so shells that wait on a reply at startup (fish) don't stall; viewers stay quiet.
  screen.onData((reply) => t.pty?.write(reply))
  screen.onTitleChange((title) => {
    if (title.trim() && title !== t.info.title) {
      t.info.title = title.trim()
      changed()
    }
  })
  terms.set(t.info.id, t)
  start(t)
  return t.info
}

/** The name asked for, else for a shell its program and the lowest number free in its workspace, e.g. "fish 2". */
function defaultName(root: string, command?: string, name?: string): string | undefined {
  if (name?.trim()) return name.trim()
  if (command) return undefined
  const taken = new Set([...terms.values()].filter((t) => t.info.root === root).map((t) => t.info.name))
  let n = 1
  while (taken.has(`${basename(SHELL)} ${n}`)) n++
  return `${basename(SHELL)} ${n}`
}

function rename(t: Term, name?: string): TerminalInfo {
  // Off first, so its own name doesn't count as taken.
  t.info.name = undefined
  t.info.name = defaultName(t.info.root, t.info.command, name)
  changed()
  return t.info
}

function start(t: Term): void {
  const [file, args] = t.info.command ? ['/bin/bash', ['-c', t.info.command]] : [SHELL, ['-l']]
  let p: IPty
  try {
    p = spawn(file, args, {
      name: 'xterm-256color',
      cols: t.cols,
      rows: t.rows,
      cwd: t.info.cwd,
      env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'badger' } as Record<string, string>,
    })
  } catch (err) {
    note(t, `failed to start: ${message(err)}`)
    Object.assign(t.info, { running: false, exitCode: -1, signal: undefined })
    changed()
    return
  }
  t.pty = p
  Object.assign(t.info, { running: true, pid: p.pid, exitCode: undefined, signal: undefined })
  p.onData((data) => {
    if (t.pty !== p) return
    t.screen.write(data, () => broadcast({ type: 'output', id: t.info.id, data }))
  })
  p.onExit(({ exitCode, signal }) => {
    if (t.pty !== p) return
    t.pty = null
    Object.assign(t.info, { running: false, pid: undefined, exitCode, signal: signal || undefined })
    // A shell that exits on its own is finished with, like closing a terminal tab.
    if (!t.info.command && !t.keep) return void remove(t).catch(() => {})
    if (!t.keep) note(t, signal ? `killed by signal ${signal}` : `exited with code ${exitCode}`)
    changed()
  })
  changed()
}

/** A dim line in the terminal itself, as if the terminal said it. */
function note(t: Term, text: string): void {
  const data = `\r\n\x1b[2m[${text}]\x1b[22m\r\n`
  t.screen.write(data, () => broadcast({ type: 'output', id: t.info.id, data }))
}

/**
 * Run a lifecycle change after any already queued for the terminal. Two
 * restarts at once would otherwise both start a process, and the one
 * overwritten would keep running where nothing can see or stop it.
 */
function serial<T>(t: Term, op: () => Promise<T>): Promise<T> {
  const run = t.ops.then(op, op)
  t.ops = run.catch(() => {})
  return run
}

/**
 * Hang up the shell and terminate everything under it, escalating to SIGKILL.
 * Resolves once the whole tree is gone, so a restart finds its ports free.
 * Only call inside serial().
 */
async function kill(t: Term): Promise<void> {
  const p = t.pty
  if (!p) return
  const tree = [p.pid, ...descendants(p.pid)]
  try {
    p.kill('SIGHUP')
  } catch {}
  for (const pid of tree.slice(1)) signal(pid, 'SIGTERM')
  const deadline = Date.now() + KILL_GRACE_MS
  while (tree.some(alive) && Date.now() < deadline) await sleep(50)
  // Look again: anything forked during the grace period goes too.
  for (const pid of new Set([...tree, ...descendants(p.pid)])) if (alive(pid)) signal(pid, 'SIGKILL')
  const exitDeadline = Date.now() + EXIT_WAIT_MS
  while (t.pty === p && Date.now() < exitDeadline) await sleep(20)
  if (t.pty === p) {
    // node-pty never reported the exit; stop waiting on it rather than hang every later operation.
    t.pty = null
    Object.assign(t.info, { running: false, exitCode: undefined, signal: 9 })
    changed()
  }
}

/** Kill a terminal's process, keeping the terminal and its output. */
function stop(t: Term): Promise<TerminalInfo> {
  return serial(t, async () => {
    if (!t.pty) return t.info
    t.keep = true
    try {
      await kill(t)
    } finally {
      t.keep = false
    }
    note(t, 'stopped')
    return t.info
  })
}

function restart(t: Term): Promise<TerminalInfo> {
  return serial(t, async () => {
    if (!terms.has(t.info.id)) throw new Error('Terminal was closed')
    t.keep = true
    try {
      await kill(t)
    } finally {
      t.keep = false
    }
    note(t, 'restarted')
    start(t)
    return t.info
  })
}

function remove(t: Term): Promise<void> {
  return serial(t, async () => {
    if (!terms.delete(t.info.id)) return
    t.keep = true
    await kill(t)
    t.screen.dispose()
    changed()
    idleCheck()
  })
}

function resize(t: Term, cols: number, rows: number): void {
  t.cols = clamp(cols, 2, 1000)
  t.rows = clamp(rows, 2, 500)
  t.screen.resize(t.cols, t.rows)
  try {
    t.pty?.resize(t.cols, t.rows)
  } catch {}
}

/** The last `lines` lines of the screen as plain text, with wrapped lines joined back up. */
function text(t: Term, lines: number): string {
  const buffer = t.screen.buffer.active
  const out: string[] = []
  for (let i = 0; i < buffer.length; i++) {
    const line = buffer.getLine(i)
    if (!line) continue
    const s = line.translateToString(true)
    if (line.isWrapped && out.length) out[out.length - 1] += s
    else out.push(s)
  }
  while (out.length && !out[out.length - 1].trim()) out.pop()
  return out.slice(-lines).join('\n')
}

/** Runs after everything already written has reached the screen. */
const flushed = (t: Term) => new Promise<void>((resolve) => t.screen.write('', resolve))

async function handle(client: Socket, req: HostRequest): Promise<void> {
  if (req.type === 'shutdown') {
    if (terms.size === 0) shutdown()
    return
  }
  const t = terms.get('id' in req ? req.id : '')
  if (req.type === 'input') return void t?.pty?.write(req.data)
  if (req.type === 'resize') return void (t && resize(t, req.cols, req.rows))

  const reply = (result?: unknown, error?: string) => send(client, { type: 'reply', reqId: req.reqId, result, error })
  try {
    if (req.type === 'create') return reply(create(req.spec))
    if (!t) return reply(undefined, `No terminal ${req.id}`)
    switch (req.type) {
      case 'snapshot':
        await flushed(t)
        return reply(t.serializer.serialize({ scrollback: SCROLLBACK }))
      case 'text':
        await flushed(t)
        return reply(text(t, req.lines))
      case 'stop':
        return reply(await stop(t))
      case 'restart':
        return reply(await restart(t))
      case 'rename':
        return reply(rename(t, req.name))
      case 'remove':
        await remove(t)
        return reply()
      default:
        // A newer server's request: answered, so it isn't left waiting.
        return reply(undefined, `Unknown request ${(req as { type: string }).type}`)
    }
  } catch (err) {
    reply(undefined, message(err))
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, Math.floor(n) || min))

// ── Lifecycle ──

let idleTimer: NodeJS.Timeout | null = null
function idleCheck(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = clients.size === 0 && terms.size === 0 ? setTimeout(shutdown, IDLE_EXIT_MS) : null
}

function shutdown(): void {
  for (const t of terms.values()) {
    for (const pid of t.pty ? [t.pty.pid, ...descendants(t.pty.pid)] : []) signal(pid, 'SIGHUP')
  }
  try {
    unlinkSync(SOCKET)
  } catch {}
  process.exit(0)
}

const server = createServer((client) => {
  clients.add(client)
  idleCheck()
  client.setEncoding('utf8')
  send(client, { type: 'hello', version: PTY_HOST_VERSION, pid: process.pid, terminals: list() })
  let buf = ''
  client.on('data', (chunk: string) => {
    buf += chunk
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      let req: HostRequest
      try {
        req = JSON.parse(line)
      } catch {
        continue
      }
      void handle(client, req)
    }
  })
  client.on('error', () => {})
  client.on('close', () => {
    clients.delete(client)
    idleCheck()
  })
})

for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, shutdown)

// A socket file left by a host that died is removed; a live host means we aren't needed.
if (existsSync(SOCKET)) {
  const probe = connect(SOCKET)
  probe.on('connect', () => {
    console.error('another PTY host is already listening; exiting')
    process.exit(0)
  })
  probe.on('error', () => {
    unlinkSync(SOCKET)
    listen()
  })
} else listen()

function listen(): void {
  server.listen(SOCKET, () => {
    chmodSync(SOCKET, 0o600)
    console.log(`PTY host ${process.pid} listening on ${SOCKET}`)
    idleCheck()
  })
}
