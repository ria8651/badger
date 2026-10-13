import { createSignal } from 'solid-js'
import { api, socket } from './api.ts'
import { openPreview } from './layout.ts'

/**
 * Where this browser reaches a port's preview, with `{port}` in it: the
 * port's own subdomain of the host Badger is on. Undefined when Badger is
 * reached by IP address, which has no subdomains.
 */
const [template, setTemplate] = createSignal<string>()

function templateFor(serverPort: number): string | undefined {
  let host = location.hostname
  // Browsers resolve every *.localhost name to this machine themselves.
  if (host === '127.0.0.1' || host === '[::1]') host = 'localhost'
  if (/^[\d.]+$/.test(host) || host.startsWith('[')) return
  // In development the page comes from Vite, but Badger's own server serves previews.
  const port = import.meta.env.DEV ? String(serverPort) : location.port
  return `${location.protocol}//{port}.${host}${port ? `:${port}` : ''}`
}

/** The server gives Claude these URLs, so they work wherever the user is looking from. */
const tellServer = () => template() && socket.send({ type: 'preview_url', url: template()! })

api.config().then((c) => {
  setTemplate(templateFor(c.port))
  if (socket.connected) tellServer()
})
socket.onConnection((connected) => connected && tellServer())

export const previewsAvailable = () => !!template()

export function previewUrl(port: number | string, path = '/'): string | undefined {
  const t = template()
  return t && t.replace('{port}', String(port)) + path
}

socket.on((e) => {
  if (e.type === 'open_preview') openPreview(e.root, e.port, { name: e.name, path: e.path })
})
