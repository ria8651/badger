import { defineConfig } from 'vite'
import solid from 'vite-plugin-solid'
import tailwindcss from '@tailwindcss/vite'

const server = `http://127.0.0.1:${process.env.PORT ?? 3001}`

export default defineConfig({
  plugins: [solid({ hot: false }), tailwindcss()],
  server: {
    // No hot updates or auto-reloads; changes show up when the page is refreshed.
    hmr: false,
    proxy: {
      '/api': server,
      '/ws': { target: server, ws: true },
    },
  },
})
