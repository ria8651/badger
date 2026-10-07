import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const server = `http://127.0.0.1:${process.env.PORT ?? 3001}`

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/api': server,
      '/ws': { target: server, ws: true },
    },
  },
})
