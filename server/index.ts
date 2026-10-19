import { mkdirSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { WebSocketServer } from 'ws'
import { LOCAL_MACHINE } from '../shared/protocol.ts'
import { Attention } from './attention.ts'
import { BRIDGE_PATH, Bridges } from './bridge.ts'
import { boardOps } from './boardTools.ts'
import { Board } from './board.ts'
import { ChatMeta } from './chatMeta.ts'
import { Database } from './db.ts'
import { loadDotEnv, shellEnv } from './env.ts'
import { apiRoutes } from './hub/api.ts'
import { serveBrowser } from './hub/browsers.ts'
import { Chats } from './hub/chats.ts'
import { httpHandler, isLoopback, sameOrigin } from './hub/http.ts'
import { RunnerLink } from './hub/runnerLink.ts'
import { HubTerminals } from './hub/terminals.ts'
import { Viewers, debounced } from './hub/viewers.ts'
import { Machines, mismatch } from './machines.ts'
import { memoryLinks, wsLink } from './peer.ts'
import { ChatPlacement } from './placement.ts'
import { proxyPreview, proxyPreviewUpgrade, previewPort } from './preview.ts'
import { bridgeOps } from './previewTools.ts'
import { Runner } from './runner.ts'
import { PROTOCOL_HEADER, RUNNER_MAX_FRAME, RUNNER_PROTOCOL } from './runnerProtocol.ts'
import { Transcripts } from './transcripts.ts'
import { AccountLimits } from './usage.ts'
import { prepareScratch } from './workspace.ts'

// Terminals get the environment Badger was started with, before .env adds PORT and friends.
const startEnv = shellEnv(process.env)
loadDotEnv()

/** How often plan usage is read again while a tab is open, besides after each turn. */
const ACCOUNT_POLL_MS = 5 * 60 * 1000
/** Changes to the chat list or runners within this long go out to tabs as one, however often runners send them. */
const LIST_DEBOUNCE_MS = 200
/** How often connected runners are pinged; one that hasn't answered the last ping by the next is dropped. */
const RUNNER_PING_MS = 30 * 1000

const PORT = Number(process.env.PORT ?? 3001)
const HOST = process.env.HOST ?? '127.0.0.1'
const WORKSPACE_DIR = resolve(process.env.WORKSPACE_DIR ?? process.cwd())
const DIST = resolve('dist')
const DATA_DIR = resolve(process.env.DATA_DIR ?? 'data')
// Folderless chats run here. Outside DATA_DIR, which defaults to inside this repo.
const SCRATCH_DIR = resolve(process.env.SCRATCH_DIR || join(homedir(), '.badger', 'scratch'))
// Bound to loopback, requests are checked to be for a local name too (see sameOrigin).
const CHECK_HOST = isLoopback(HOST)

mkdirSync(WORKSPACE_DIR, { recursive: true })
prepareScratch(SCRATCH_DIR)

// ── The hub's parts, and what each tells the browsers ──

const viewers = new Viewers()
/** Tells every tab to fetch the chat list again; each fetch asks every machine about its folders. */
const listChanged = debounced(() => viewers.toAll({ type: 'sessions_changed' }), LIST_DEBOUNCE_MS)
const machinesChanged = debounced(() => viewers.toAll({ type: 'machines', machines: machines.list() }), LIST_DEBOUNCE_MS)
const cardsChanged = () => viewers.toAll({ type: 'cards_changed' })

const db = new Database(DATA_DIR)
const meta = new ChatMeta(db, listChanged)
const board = new Board(db, meta)
const transcripts = new Transcripts(db.sql)
const placement = new ChatPlacement(db)
const bridges = new Bridges()
const bridge = bridgeOps(bridges)

const machines: Machines = new Machines(db.sql, placement, {
  onChange: (id, runner) => link.onChange(id, runner),
  onEvent: (machine, event) => link.onEvent(machine, event),
})
const attention = new Attention(meta, () => machines.allLive().flatMap((s) => (s.waiting ? [s.id] : [])), (e) => viewers.publish(e))
const account = new AccountLimits(
  () => machines.any()?.remote.accountUsage(),
  (usage) => viewers.toAll({ type: 'account_usage', usage }),
)
const terminals = new HubTerminals(machines, placement, viewers)
const chats = new Chats({ db, board, meta, transcripts, machines, placement, viewers, attention, scratchDir: SCRATCH_DIR, listChanged, cardsChanged })
const link: RunnerLink = new RunnerLink({
  db,
  board,
  meta,
  transcripts,
  machines,
  placement,
  chats,
  terminals,
  viewers,
  attention,
  account,
  ops: [...boardOps({ board, meta, onChange: cardsChanged, chats: (ids) => chats.info(ids) }), ...bridge],
  hubOnly: new Set(bridge.map((o) => o.script)),
  listChanged,
  machinesChanged,
})

// Limits move with use on other machines too, so read them now and then while anyone's looking.
setInterval(() => viewers.count && void account.refresh(), ACCOUNT_POLL_MS).unref()

// ── HTTP and WebSockets ──

const PREVIEW_HOSTS = { ownPort: PORT, localOnly: CHECK_HOST }

const api = httpHandler(
  [
    ...apiRoutes({ board, transcripts, machines, chats, cardsChanged, listChanged, config: { defaultCwd: WORKSPACE_DIR, scratchCwd: SCRATCH_DIR, port: PORT } }),
    ...chats.routes(),
    ...terminals.routes(),
  ],
  { dist: DIST, checkHost: CHECK_HOST },
)

const server = createServer((req, res) => {
  const preview = previewPort(req.headers.host, PREVIEW_HOSTS)
  if (preview) return proxyPreview(req, res, preview)
  void api(req, res)
})

const wss = new WebSocketServer({ noServer: true })
// Transcript lines can be big (pasted images); runners send bigger ones as blanks (see sync.ts).
const runnerWss = new WebSocketServer({ noServer: true, maxPayload: RUNNER_MAX_FRAME })

server.on('upgrade', (req, socket, head) => {
  const preview = previewPort(req.headers.host, PREVIEW_HOSTS)
  if (preview) {
    if (req.url === `${BRIDGE_PATH}bridge`) return bridges.upgrade(req, socket, head, preview)
    return proxyPreviewUpgrade(req, socket, head, preview)
  }
  const url = new URL(req.url ?? '/', 'http://x')
  const refuse = (status: string, why = '') => {
    socket.write(`HTTP/1.1 ${status}\r\ncontent-type: text/plain\r\nconnection: close\r\n\r\n${why}`)
    socket.destroy()
  }
  if (url.pathname === '/runner') {
    // A runner: no browser session, so it's let through the proxy in front and has a token instead.
    const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')
    const machine = token ? machines.byToken(token) : undefined
    if (!machine) return refuse('401 Unauthorized', 'Unknown or revoked runner token')
    if (req.headers[PROTOCOL_HEADER] !== String(RUNNER_PROTOCOL)) {
      const why = mismatch(req.headers[PROTOCOL_HEADER])
      machines.refused(machine, why)
      return refuse('426 Upgrade Required', why)
    }
    // Dropped if it stops answering pings, e.g. a laptop that went to sleep mid-connection.
    return runnerWss.handleUpgrade(req, socket, head, (ws) => machines.attach(machine, wsLink(ws, { pingMs: RUNNER_PING_MS }), link.api, token))
  }
  if (url.pathname !== '/ws') return refuse('404 Not Found')
  if (!sameOrigin(req, CHECK_HOST)) return refuse('403 Forbidden')
  wss.handleUpgrade(req, socket, head, (ws) => serveBrowser(ws, { viewers, chats, terminals, machines, attention, account }))
})

// ── The hub's own machine: a runner in this process, over an in-memory link ──

const runner = new Runner({ workspaceDir: WORKSPACE_DIR, scratchDir: SCRATCH_DIR, dataDir: DATA_DIR, env: startEnv })
const [hubEnd, runnerEnd] = memoryLinks()
// Before the hub's runner connects, so its first chat list has them.
placement.importOlderChats(join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects'))
machines.attach(LOCAL_MACHINE, hubEnd, link.api)
runner.connect(runnerEnd).catch((err) => console.error('The hub’s own runner failed to start:', err))

server.listen(PORT, HOST, () => {
  console.log(`badger server on http://${HOST}:${PORT} (workspace ${WORKSPACE_DIR})`)
})

// A promise nobody caught, e.g. from a runner's odd answer, is a bug to fix, not a reason to drop every chat.
process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err))

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    runner.closeAll()
    process.exit(0)
  })
}
