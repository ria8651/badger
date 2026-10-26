import { readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createRequire } from 'node:module'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'

/**
 * The bridge: a script the preview proxy puts in every page it serves, which
 * connects back here so Claude can work with the page the user actually has
 * open, with their login and whatever state they've got it into. It runs
 * code in the page, reads its console and renders it to an image. Claude
 * uses it through the preview_* operations (server/previewTools.ts).
 */

/** Where the bridge's files and socket live on every preview's origin. */
export const BRIDGE_PATH = '/__badger/'

/** A page with the bridge running in it. */
interface Page {
  ws: WebSocket
  port: number
  url: string
  title: string
  visible: boolean
  /** When the user last did something in it, or it loaded. */
  active: number
  connected: number
}

export interface PageInfo {
  port: number
  url: string
  title: string
  visible: boolean
  /** Seconds since the user last did something in it. */
  idle: number
}

type Pending = { page: Page; resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }

/** How long to wait for a page to (re)connect, e.g. while it reloads. */
const CONNECT_WAIT_MS = 5000

export class Bridges {
  private pages = new Set<Page>()
  private pending = new Map<number, Pending>()
  private waiters = new Set<() => void>()
  private nextId = 1
  private wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 })

  /** A page's bridge connecting. Only that preview's own pages may: the Origin must be the preview's. */
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer, port: number): void {
    let origin: URL | undefined
    try {
      origin = new URL(req.headers.origin ?? '')
    } catch {}
    if (origin?.host !== req.headers.host) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
      return void socket.destroy()
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.add(ws, port))
  }

  private add(ws: WebSocket, port: number): void {
    const now = Date.now()
    const page: Page = { ws, port, url: '', title: '', visible: true, active: now, connected: now }
    this.pages.add(page)
    ws.on('message', (raw) => {
      let m: any
      try {
        m = JSON.parse(String(raw))
      } catch {
        return
      }
      if (m.type === 'state') {
        Object.assign(page, { url: String(m.url), title: String(m.title), visible: !!m.visible })
        if (m.active) page.active = Date.now()
        this.changed()
      } else if (m.type === 'result') {
        const p = this.pending.get(m.id)
        if (p?.page !== page) return
        this.pending.delete(m.id)
        clearTimeout(p.timer)
        if (m.ok) p.resolve(m.value)
        else p.reject(new Error(String(m.error)))
      }
    })
    // Errors, e.g. a message over maxPayload, end in a close, which is what's listened for. Unheard, one would crash the process.
    ws.on('error', () => {})
    ws.on('close', () => {
      this.pages.delete(page)
      for (const [id, p] of this.pending) {
        if (p.page !== page) continue
        this.pending.delete(id)
        clearTimeout(p.timer)
        p.reject(new Error('The page went away before answering: it navigated, reloaded or was closed.'))
      }
      this.changed()
    })
  }

  private changed(): void {
    for (const w of this.waiters) w()
  }

  /** Resolves with what find returns once it returns something, or undefined after ms. */
  private until<T>(find: () => T | undefined, ms: number): Promise<T | undefined> {
    const found = find()
    if (found !== undefined || ms <= 0) return Promise.resolve(found)
    return new Promise((resolve) => {
      const done = (v: T | undefined) => (this.waiters.delete(check), clearTimeout(timer), resolve(v))
      const check = () => {
        const v = find()
        if (v !== undefined) done(v)
      }
      const timer = setTimeout(() => done(undefined), ms)
      this.waiters.add(check)
    })
  }

  list(): PageInfo[] {
    return this.ranked().map((p) => ({ port: p.port, url: p.url, title: p.title, visible: p.visible, idle: Math.round((Date.now() - p.active) / 1000) }))
  }

  /** Visible pages first, then the one the user was in last. */
  private ranked(port?: number): Page[] {
    return [...this.pages]
      .filter((p) => p.url && (port === undefined || p.port === port))
      .sort((a, b) => Number(b.visible) - Number(a.visible) || b.active - a.active)
  }

  /** The page on a port to act on, waiting a little for one: it may be loading. */
  private async page(port: number): Promise<Page> {
    const page = await this.until(() => this.ranked(port)[0], CONNECT_WAIT_MS)
    if (!page) throw new NotOpen(port)
    return page
  }

  private ask(page: Page, request: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`The page didn't answer within ${timeoutMs / 1000}s.`))
      }, timeoutMs)
      this.pending.set(id, { page, resolve, reject, timer })
      page.ws.send(JSON.stringify({ ...request, id }))
    })
  }

  /** Runs a request in the page on port the user was last in, and says which page that was. */
  async call(port: number, request: Record<string, unknown>, timeoutMs: number): Promise<{ url: string; value: unknown }> {
    const page = await this.page(port)
    if (request.op !== 'goto') return { url: page.url, value: await this.ask(page, request, timeoutMs) }
    // Going somewhere either loads a new page, which connects afresh, or moves this one (a hash, a single-page app).
    const start = Date.now()
    const before = page.url
    await this.ask(page, request, timeoutMs)
    const after = await this.until(
      () => this.ranked(port).find((p) => p.connected > start || (p === page && p.url !== before)),
      timeoutMs,
    )
    if (!after) throw new Error(`The page didn't arrive within ${timeoutMs / 1000}s; it may still be loading.`)
    return { url: after.url, value: undefined }
  }
}

export class NotOpen extends Error {
  constructor(port: number) {
    super(
      `No page from port ${port} is open with the bridge. The user needs it open in Badger's preview panel or a browser tab (open_preview shows it). A page open since before Badger had the bridge needs a reload.`,
    )
  }
}

// ── Files served on preview origins ──

const require = createRequire(import.meta.url)

/**
 * The bridge script, with a source map that puts it on DevTools' ignore list:
 * it wraps console, and the page's logs should still point at the page's code.
 */
const pageScript = (() => {
  const code = readFileSync(new URL('./bridge-page.js', import.meta.url), 'utf8')
  const lines = code.split('\n').length
  const map = { version: 3, sources: ['badger-bridge.js'], sourcesContent: [code], mappings: 'AAAA' + ';AACA'.repeat(lines - 1), x_google_ignoreList: [0] }
  return `${code}\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(map)).toString('base64')}\n`
})()

let screenshotScript: string | undefined

/** Serves the bridge's files on a preview origin. Returns false for anything else under its path. */
export function serveBridgeFile(path: string, res: ServerResponse): boolean {
  let body: string
  if (path === `${BRIDGE_PATH}bridge.js`) body = pageScript
  else if (path === `${BRIDGE_PATH}screenshot.js`) body = screenshotScript ??= readFileSync(require.resolve('modern-screenshot').replace(/\.c?js$/, '.mjs'), 'utf8')
  else return false
  res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' })
  res.end(body)
  return true
}

/** Where the bridge's script tag goes: early in head, so the console is caught from the start. */
export function injectBridge(html: string): string {
  const tag = `<script src="${BRIDGE_PATH}bridge.js"></script>`
  for (const re of [/<head(\s[^>]*)?>/i, /<html(\s[^>]*)?>/i, /<!doctype[^>]*>/i]) {
    const m = re.exec(html)
    if (m) return html.slice(0, m.index + m[0].length) + tag + html.slice(m.index + m[0].length)
  }
  return tag + html
}

/**
 * Lets a page's own Content-Security-Policy load the bridge, connect it and
 * take screenshots: sources are added to whichever directive governs each.
 * Allowing data: and blob: images is a small loosening of the page's policy.
 */
export function allowBridge(policy: string, origin: string): string {
  const directives = policy.split(';').map((d) => d.trim()).filter(Boolean)
  const name = (d: string) => d.split(/\s+/)[0].toLowerCase()
  const add = (names: string[], source: string) => {
    let governing = directives.flatMap((d, i) => (names.includes(name(d)) ? [i] : []))
    if (!governing.length) governing = directives.flatMap((d, i) => (name(d) === 'default-src' ? [i] : []))
    for (const i of governing) directives[i] = [...directives[i].split(/\s+/).filter((p) => p.toLowerCase() !== "'none'"), source].join(' ')
  }
  const ws = origin.replace(/^http/, 'ws')
  add(['script-src-elem', 'script-src'], `${origin}${BRIDGE_PATH}`)
  add(['connect-src'], `${ws}${BRIDGE_PATH}`)
  // Screenshots draw the page as an SVG image from a data: URL; without these they come out blank.
  add(['img-src'], 'data:')
  add(['img-src'], 'blob:')
  return directives.join('; ')
}
