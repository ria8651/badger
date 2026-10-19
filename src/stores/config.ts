import { createSignal } from 'solid-js'
import { api, socket, type Config } from '../api.ts'

/** The server's config, once it's been fetched; fetched on the first connect that can, and then kept. */
const [config, setConfig] = createSignal<Config>()
export { config }

let resolve!: (c: Config) => void
/** Settles once the config has arrived, so what needs it (the folder defaults, previews) can wait for it. */
export const configReady = new Promise<Config>((r) => (resolve = r))

let asking = false
const fetchConfig = () => {
  if (config() || asking) return
  asking = true
  api
    .config()
    .then((c) => (setConfig(c), resolve(c)))
    // The next reconnect tries again.
    .catch(() => {})
    .finally(() => (asking = false))
}
// Every connect tries until it's in, so a server that was down when the page opened is picked up once it's back.
socket.onConnection((connected) => connected && fetchConfig())
if (socket.connected) fetchConfig()
