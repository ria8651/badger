import { request, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http'
import { connect, type LookupFunction } from 'node:net'
import type { Duplex } from 'node:stream'

/**
 * Previews: `<port>.<Badger's host>` is whatever listens on that port on this
 * machine, e.g. `5173.badger.example.com` or `5173.localhost:3001`. Each port
 * gets an origin of its own, so dev servers can assume they're at `/`, and a
 * page they serve can't reach Badger's API or another preview's storage.
 */

/** The port a request's Host asks for, if it's a preview. */
export function previewPort(host: string | undefined, opts: { ownPort: number; localOnly: boolean }): number | undefined {
  if (!host) return
  let hostname: string
  try {
    hostname = new URL(`http://${host}`).hostname
  } catch {
    return
  }
  const m = hostname.match(/^(\d{1,5})\.(.+)$/)
  // An IPv4 address starts with digits too.
  if (!m || /^[\d.]+$/.test(m[2])) return
  // Bound to loopback, only *.localhost: a hostile name resolving here (DNS rebinding) must not reach the user's ports.
  if (opts.localOnly && m[2] !== 'localhost') return
  const port = Number(m[1])
  // Badger itself would run its own UI on a preview origin, where its same-origin check can't tell the page apart.
  if (port < 1 || port > 65535 || port === opts.ownPort) return
  return port
}

/**
 * Where a port's dev server is: it may listen on 127.0.0.1, ::1 or both, and
 * `localhost` may resolve to only one of them, so connections try each in turn.
 */
const LOOPBACK = {
  host: 'localhost',
  autoSelectFamily: true,
  lookup: ((_host, opts, cb) =>
    opts.all
      ? cb(null, [{ address: '127.0.0.1', family: 4 }, { address: '::1', family: 6 }])
      : cb(null, '127.0.0.1', 4)) as LookupFunction,
}

const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade']

/**
 * What the browser called it, so the dev server sees itself at localhost and
 * its redirects can be turned back, and where Badger's page is: the same host
 * without the port label, on any port (in development it's Vite's).
 */
function origins(req: IncomingMessage, port: number) {
  const proto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() || 'http'
  const badger = new URL(`http://${req.headers.host}`).hostname.replace(/^\d+\./, '')
  return { outside: `${proto}://${req.headers.host}`, inside: `http://localhost:${port}`, badger: `${proto}://${badger}:*` }
}

/**
 * The browser's headers as the dev server expects them: addressed to
 * localhost (Vite refuses hosts it doesn't know), and requests from the
 * preview's own page marked as same-origin. Other origins pass through as
 * they are, so one preview can't pass for another.
 */
function inward(headers: IncomingHttpHeaders, o: { outside: string; inside: string }, port: number): IncomingHttpHeaders {
  const out: IncomingHttpHeaders = { ...headers, host: `localhost:${port}` }
  if (out.origin === o.outside) out.origin = o.inside
  if (out.referer?.startsWith(o.outside + '/')) out.referer = o.inside + out.referer.slice(o.outside.length)
  return out
}

export function proxyPreview(req: IncomingMessage, res: ServerResponse, port: number): void {
  const o = origins(req, port)
  const headers = inward(req.headers, o, port)
  for (const h of HOP_BY_HOP) delete headers[h]
  const upstream = request({ ...LOOPBACK, port, method: req.method, path: req.url, headers }, (up) => {
    const out = { ...up.headers }
    for (const h of HOP_BY_HOP) delete out[h]
    // Badger shows previews in a frame, so the page's own rules on framing give way to one: only Badger's page may.
    delete out['x-frame-options']
    const csp = [out['content-security-policy'] ?? []].flat().map((p) => p.replace(/(^|;)\s*frame-ancestors[^;]*/gi, '$1').replace(/^;\s*|;\s*$/g, ''))
    out['content-security-policy'] = [...csp.filter(Boolean), `frame-ancestors ${o.badger}`]
    for (const local of [o.inside, `http://127.0.0.1:${port}`, `http://[::1]:${port}`]) {
      const at = out.location?.[local.length]
      if (out.location?.startsWith(local) && (at === undefined || '/?#'.includes(at))) out.location = o.outside + out.location.slice(local.length)
    }
    res.writeHead(up.statusCode ?? 502, up.statusMessage, out)
    up.pipe(res)
  })
  // A browser that goes away mid-response (a reload, an event stream) lets go of the dev server's connection too.
  res.on('close', () => upstream.destroy())
  req.on('error', () => upstream.destroy())
  upstream.on('error', () => {
    if (res.headersSent) return void res.destroy()
    res.writeHead(502, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-badger-waiting': '1' })
    res.end(waiting(port))
  })
  req.pipe(upstream)
}

/** WebSockets (e.g. hot reload): the handshake is passed on with the same changes, then bytes both ways. */
export function proxyPreviewUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, port: number): void {
  const o = origins(req, port)
  const headers = inward(req.headers, o, port)
  const upstream = connect({ ...LOOPBACK, port })
  upstream.on('connect', () => {
    let handshake = `${req.method} ${req.url} HTTP/1.1\r\n`
    for (const [name, value] of Object.entries(headers)) {
      for (const v of Array.isArray(value) ? value : [value]) if (v !== undefined) handshake += `${name}: ${v}\r\n`
    }
    upstream.write(handshake + '\r\n')
    if (head.length) upstream.write(head)
    socket.pipe(upstream).pipe(socket)
  })
  const close = () => (socket.destroy(), upstream.destroy())
  upstream.on('error', close)
  socket.on('error', close)
  upstream.on('close', () => socket.destroy())
  socket.on('close', () => upstream.destroy())
}

/**
 * Shown until something listens: it checks again by itself, so a preview
 * opened before its server is up comes up with it. It asks in the background
 * and reloads only once something answers, so the page doesn't flash meanwhile.
 */
function waiting(port: number): string {
  return `<!doctype html><meta charset="utf-8"><title>:${port}</title>
<style>body{font:13px system-ui,sans-serif;color:#888;display:grid;place-items:center;height:100vh;margin:0}@media(prefers-color-scheme:dark){body{background:#1a1a1a}}</style>
<p>Nothing is listening on port ${port} yet.</p>
<script>setInterval(() => fetch(location.href, { cache: 'no-store' }).then((r) => r.headers.has('x-badger-waiting') || location.reload(), () => {}), 2000)</script>`
}
