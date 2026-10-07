// Runs the server and restarts it only when Enter is pressed. File changes are
// ignored on purpose: a chat running inside Badger that edits server code
// would otherwise kill its own Claude Code process mid-turn.
import { spawn } from 'node:child_process'

let child = null
let restarting = false

function start() {
  child = spawn('tsx', ['server/index.ts'], { stdio: ['ignore', 'inherit', 'inherit'] })
  child.on('exit', (code, signal) => {
    child = null
    if (restarting) {
      restarting = false
      start()
    } else {
      console.log(`[server] exited (${signal ?? code}); press Enter to start`)
    }
  })
}

process.stdin.on('data', () => {
  console.log('[server] reloading…')
  if (!child) return start()
  restarting = true
  child.kill('SIGTERM')
})

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    child?.kill(sig)
    process.exit(0)
  })
}

console.log('[server] press Enter to reload')
start()
