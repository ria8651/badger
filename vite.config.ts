import { execFileSync } from 'node:child_process'
import { defineConfig } from 'vite'
import solid from 'vite-plugin-solid'
import tailwindcss from '@tailwindcss/vite'

const server = `http://127.0.0.1:${process.env.PORT ?? 3001}`

/** The commit the page is built from, so a tab running an old build can be told apart. CI passes it in; the image has no .git. */
function build(): string | undefined {
  if (process.env.BADGER_VERSION) return process.env.BADGER_VERSION
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined
  } catch {
    return undefined
  }
}

export default defineConfig({
  plugins: [solid({ hot: false }), tailwindcss()],
  define: { __BADGER_BUILD__: JSON.stringify(build()) },
  server: {
    // No hot updates or auto-reloads; changes show up when the page is refreshed.
    hmr: false,
    // Keep the browser's Host so the server's same-origin check sees it match Origin.
    proxy: {
      '/api': { target: server, changeOrigin: false },
      '/ws': { target: server, ws: true, changeOrigin: false },
      // So runners can connect to the hub at the address its page is on.
      '/runner': { target: server, ws: true, changeOrigin: false },
    },
  },
})
