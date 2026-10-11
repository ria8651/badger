/**
 * `badger remote`: runs chats and terminals on this machine for a Badger hub
 * elsewhere. It connects out to the hub, so it works from behind NAT, and
 * reconnects whenever the connection drops; Claude keeps working meanwhile.
 *
 *   pnpm remote --hub https://badger.example.com --token badger_… [--workspace ~/code]
 *
 * The token comes from the hub's Machines page. BADGER_HUB, BADGER_TOKEN and
 * WORKSPACE_DIR work too.
 */
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { WebSocket } from 'ws'
import { wsLink } from './peer.ts'
import { Runner } from './runner.ts'
import { PROTOCOL_HEADER, RUNNER_PROTOCOL } from './runnerProtocol.ts'
import { shellEnv } from './terminals.ts'
import { prepareScratch } from './workspace.ts'

/** How often the hub is pinged; a connection that hasn't answered the last ping by the next is dropped and made again. */
const PING_MS = 30 * 1000
const MAX_RETRY_MS = 30 * 1000
/** After the hub turns this runner's version away, try again this rarely: one of them has to be updated first. */
const MISMATCH_RETRY_MS = 5 * 60 * 1000

const { values: args } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== 'remote'),
  options: {
    hub: { type: 'string' },
    token: { type: 'string' },
    workspace: { type: 'string' },
    data: { type: 'string' },
  },
})

const hub = args.hub ?? process.env.BADGER_HUB
const token = args.token ?? process.env.BADGER_TOKEN
if (!hub || !token) {
  console.error('Usage: pnpm remote --hub https://your-badger --token badger_…  (add a machine on the hub to get a token)')
  process.exit(1)
}

const url = new URL('/runner', hub)
url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
const workspaceDir = resolve(args.workspace ?? process.env.WORKSPACE_DIR ?? homedir())
const scratchDir = resolve(process.env.SCRATCH_DIR || join(homedir(), '.badger', 'scratch'))
// Not a hub's DATA_DIR: this machine may run a hub of its own, with its own terminals.
const dataDir = resolve(args.data ?? join(homedir(), '.badger', 'runner'))
mkdirSync(dataDir, { recursive: true })
prepareScratch(scratchDir)

const runner = new Runner({ workspaceDir, scratchDir, dataDir, env: shellEnv(process.env) })
let retries = 0
let lastError = ''

function connect(): void {
  const ws = new WebSocket(url, {
    headers: { authorization: `Bearer ${token}`, [PROTOCOL_HEADER]: String(RUNNER_PROTOCOL) },
    maxPayload: 512 * 1024 * 1024,
  })
  let alive = true
  let ping: ReturnType<typeof setInterval> | undefined
  let retryIn: number | undefined

  ws.on('open', () => {
    ws.on('pong', () => (alive = true))
    ping = setInterval(() => {
      if (!alive) return ws.terminate()
      alive = false
      ws.ping()
    }, PING_MS)
    runner.connect(wsLink(ws)).then(
      (me) => {
        retries = 0
        lastError = ''
        console.log(`Connected to ${hub} as ${me.name}`)
      },
      (err) => {
        console.error(`The hub didn't take this runner: ${err.message}`)
        retryIn = MISMATCH_RETRY_MS
        ws.close()
      },
    )
  })
  let refused = false
  ws.on('unexpected-response', (_req, res) => {
    refused = true
    let body = ''
    res.on('data', (c) => (body += c))
    res.on('end', () => {
      if (res.statusCode === 401) {
        console.error(`The hub doesn't know this token (${body || 'unauthorised'}). Add the machine again on the hub's Machines page.`)
        process.exit(1)
      }
      if (res.statusCode === 426) retryIn = MISMATCH_RETRY_MS
      report(
        res.statusCode === 404
          ? `Nothing to connect to at ${url}: check --hub is the hub's server (not the Vite dev port), and that the hub's Badger is new enough to have Machines.`
          : `The hub refused the connection: ${res.statusCode} ${body}`.trim(),
      )
      ws.terminate()
    })
  })
  // Terminating a refused connection errors too; that's already been said.
  ws.on('error', (err) => !refused && report(`Can't reach ${hub}: ${err.message}`))
  ws.on('close', () => {
    clearInterval(ping)
    const delay = retryIn ?? Math.min(MAX_RETRY_MS, 1000 * 2 ** retries++)
    setTimeout(connect, delay)
  })
}

/** Says what went wrong once per streak of the same failure, not on every retry. */
function report(message: string): void {
  if (message === lastError) return
  lastError = message
  console.error(message)
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    runner.closeAll()
    process.exit(0)
  })
}

console.log(`Badger runner for ${hub}, workspace ${workspaceDir}`)
connect()
