import { createReadStream, existsSync, statSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, join } from 'node:path'
import { BadRequest, message } from '../errors.ts'

/** A request to one of the routes. */
export interface Request {
  url: URL
  /** What the route's pattern captured. */
  params: string[]
  /** The body, parsed; {} when there's none. */
  json(): Promise<any>
}

/** JSON with a status (204 has no body), or bytes with headers of their own. */
export type Reply = [status: number, body: unknown] | { status: number; headers: Record<string, string>; data: Buffer | string }

/** A method, a path (whole, or a pattern matching all of it), and what answers it. */
export type Route = [method: string, path: string | RegExp, handler: (req: Request) => Reply | Promise<Reply>]

/** A route pattern's piece matching a chat id. */
export const CHAT_ID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})'

const MIME: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
}

const LOCAL_NAMES = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * Only the page this server serves may use it. Without auth, any website the
 * user visits could otherwise POST a command into a terminal or open the
 * WebSocket and type into one. The Origin check stops cross-site requests.
 * Requests with no Origin (curl, same-origin GETs) are allowed.
 *
 * Bound to loopback (`checkHost`), the Host check also stops DNS rebinding (a
 * hostile name resolving to 127.0.0.1). Bound wider, whatever fronts the port
 * (an auth proxy) is the guard: a rebound name reaches the proxy without a
 * session.
 *
 * Runners don't come through here: they have a token instead (see `/runner`).
 */
export function sameOrigin(req: IncomingMessage, checkHost: boolean): boolean {
  const host = req.headers.host
  if (!host || (checkHost && !LOCAL_NAMES.has(new URL(`http://${host}`).hostname))) return false
  const origin = req.headers.origin
  if (!origin) return true
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/** Whether binding to this host means only this machine can connect. */
export const isLoopback = (host: string) => LOCAL_NAMES.has(host) || host === '::1'

/**
 * Answers the API's routes under /api/, and otherwise serves the built
 * client from `dist`, falling back to index.html for the client's own routes.
 * A BadRequest is a 400 saying why; anything else thrown is a 500.
 */
export function httpHandler(
  routes: Route[],
  opts: {
    dist: string
    checkHost: boolean
    /** Told of every API request that isn't a GET, once it's answered: what the user did through the API. */
    onChange?: (r: { method: string; path: string; status: number; ms: number }) => void
  },
) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://x')
    const { onChange } = opts
    if (onChange && req.method !== 'GET' && url.pathname.startsWith('/api/')) {
      const start = Date.now()
      res.once('finish', () => onChange({ method: req.method ?? '', path: url.pathname, status: res.statusCode, ms: Date.now() - start }))
    }
    const json = (status: number, body: unknown) => {
      if (status === 204) return void res.writeHead(204).end()
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (!sameOrigin(req, opts.checkHost)) return json(403, { error: 'Cross-origin requests are not allowed' })
    try {
      if (url.pathname.startsWith('/api/')) {
        const method = req.method ?? 'GET'
        for (const [m, path, handler] of routes) {
          if (m !== method) continue
          const match = typeof path === 'string' ? (path === url.pathname ? [path] : null) : url.pathname.match(path)
          if (!match) continue
          const reply = await handler({ url, params: match.slice(1), json: () => readJson(req) })
          if (Array.isArray(reply)) return json(...reply)
          res.writeHead(reply.status, reply.headers)
          return void res.end(reply.data)
        }
        return json(404, { error: 'Not found' })
      }
      let file = join(opts.dist, url.pathname)
      if (!file.startsWith(opts.dist) || !existsSync(file) || statSync(file).isDirectory()) file = join(opts.dist, 'index.html')
      if (!existsSync(file)) return json(404, { error: 'Client not built; run `pnpm build` or use `pnpm dev`' })
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' })
      createReadStream(file).pipe(res)
    } catch (err) {
      // Failed partway through a response: too late to say why.
      if (res.headersSent) return void res.destroy()
      if (err instanceof BadRequest) return json(400, { error: err.message })
      json(500, { error: message(err) })
    }
  }
}

async function readJson(req: IncomingMessage): Promise<any> {
  let body = ''
  for await (const chunk of req) body += chunk
  try {
    return body ? JSON.parse(body) : {}
  } catch {
    throw new BadRequest('Invalid JSON')
  }
}
