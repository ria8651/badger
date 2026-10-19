import { Worker } from 'node:worker_threads'
import { z } from 'zod'
import { message } from './errors.ts'
import { OpError, clip, op, runForScript, signature, type Op, type OpContext } from './ops.ts'

/** Most output a script hands back; Claude reads all of it. */
const MAX_OUTPUT_CHARS = 30_000
const DEFAULT_TIMEOUT_S = 600

/**
 * The script, in a worker thread so a slow or stuck one can't hold up the
 * chats around it, and can be stopped. It gets `badger` and `console`, and
 * nothing of Badger's own: every call goes back to the main thread as a
 * message, which runs the op as the chat whose script it is. It isn't a
 * sandbox (Claude has Bash anyway), just a worker.
 */
const WORKER = `
const { parentPort, workerData } = require('node:worker_threads')
const { inspect } = require('node:util')
const waiting = new Map()
let next = 1
parentPort.on('message', (m) => {
  const w = waiting.get(m.id)
  waiting.delete(m.id)
  if (m.error !== undefined) w?.reject(new Error(m.error))
  else w?.resolve(m.value)
})
function call(name, input = {}) {
  // Code for a page can be a function: its source goes over, and it's called there.
  if (input && typeof input.code === 'function') input = { ...input, code: '(' + input.code + ')()' }
  return new Promise((resolve, reject) => {
    const id = next++
    waiting.set(id, { resolve, reject })
    parentPort.postMessage({ t: 'call', id, name, input })
  })
}
const known = new Set(workerData.names)
const missing = (name) => Promise.reject(new Error('No badger.' + name + '; the run_script tool lists them.'))
// A function, so calling a group that isn't one (\`badger.cardz()\`) says so too.
const group = (prefix) =>
  new Proxy(() => {}, {
    get: (_, key) => {
      if (typeof key !== 'string' || key === 'then') return undefined
      const name = prefix ? prefix + '.' + key : key
      if (known.has(name)) return (input) => call(name, input)
      if (!prefix) return group(key)
      return () => missing(name)
    },
    apply: () => missing(prefix),
  })
const show = (v) => (typeof v === 'string' ? v : inspect(v, { depth: 6, breakLength: 120 }))
const log = (...args) => parentPort.postMessage({ t: 'log', text: args.map(show).join(' ') })
const console = { log, info: log, warn: log, error: log, debug: log }
const AsyncFunction = (async () => {}).constructor
// Not a sandbox, but the usual module globals aren't offered: scripts are for Badger's ops, and files and commands for Claude's own tools.
const params = ['badger', 'console', 'require', 'process', 'module', 'exports', '__filename', '__dirname']
let run
try {
  // An expression gives its value; anything else runs as a function body, so it can return one.
  run = new AsyncFunction(...params, 'return (' + workerData.code + '\\n)')
} catch {
  run = new AsyncFunction(...params, workerData.code)
}
run(group(''), console).then(
  (value) => parentPort.postMessage({ t: 'done', value: value === undefined ? undefined : (JSON.stringify(value) ?? JSON.stringify(show(value))) }),
  (err) => parentPort.postMessage({ t: 'done', error: err instanceof Error ? err.message : String(err) }),
)
`

const HELP = `Run JavaScript with Badger's tools as functions: the same operations as its MCP tools, taking the same input, but returning data instead of text. Use it for bulk changes, or anything you'd otherwise do in many tool calls or that needs filtering.

The code runs as an async function: an expression gives its value, a body can \`return\` one, and \`await\` works. The result comes back as JSON (or as it is, if it's a string), after anything console.log printed. A failed call throws, with the reason. Scripts are for Badger's functions: read files and run commands with your own tools, and put what you need into the script.

  const cards = await badger.cards.list({ status: 'review' })
  for (const c of cards) await badger.cards.update({ id: c.id, status: 'done' })
  return cards.map((c) => c.title)`

export const SCRIPT_TOOL = 'run_script'

/**
 * Scripts over the other ops, for a chat. `ops` is every op this chat has;
 * the help lists them with their inputs and what they return.
 */
export function scriptOp(server: string, ops: () => Op[]): Op {
  const usable = () => ops().filter((o) => o.script !== 'script.run')
  return op({
    server,
    tool: SCRIPT_TOOL,
    script: 'script.run',
    get description() {
      const list = usable().map((o) => `${signature(o)}\n    ${o.description.split(/(?<=\.)\s+(?=[A-Z])/)[0]} Returns ${o.returns}`)
      return `${HELP}\n\nFunctions:\n${list.join('\n')}`
    },
    input: {
      code: z.string().min(1).describe('JavaScript, run as the body of an async function'),
      timeout: z.number().min(1).max(3600).optional().describe(`Seconds before it's stopped (default ${DEFAULT_TIMEOUT_S})`),
    },
    returns: 'what the script returned',
    async run(args, ctx) {
      const { value, logs } = await runScript(args.code, usable(), ctx, (args.timeout ?? DEFAULT_TIMEOUT_S) * 1000)
      const result = value === undefined ? undefined : JSON.parse(value)
      const shown = result === undefined ? '' : typeof result === 'string' ? result : JSON.stringify(result, null, 2)
      return { text: clip([...logs, shown].filter(Boolean).join('\n'), MAX_OUTPUT_CHARS) || '(no output)', value: result }
    },
  })
}

/** Runs a script until it settles, is stopped, or runs out of time. Its value comes back as JSON. */
function runScript(code: string, ops: Op[], ctx: OpContext, timeoutMs: number): Promise<{ value?: string; logs: string[] }> {
  return new Promise((resolve, reject) => {
    const logs: string[] = []
    const worker = new Worker(WORKER, { eval: true, workerData: { code, names: ops.map((o) => o.script) }, stdout: true, stderr: true })
    let done = false
    const finish = (err: Error | null, value?: string) => {
      if (done) return
      done = true
      clearTimeout(timer)
      ctx.signal?.removeEventListener('abort', onAbort)
      void worker.terminate()
      if (err) reject(new OpError([...logs, err.message].join('\n')))
      else resolve({ value, logs })
    }
    const onAbort = () => finish(new Error('Stopped.'))
    const timer = setTimeout(() => finish(new Error(`Stopped after ${timeoutMs / 1000}s. Pass a longer timeout if it needs one.`)), timeoutMs)
    ctx.signal?.addEventListener('abort', onAbort, { once: true })
    worker.on('message', async (m: { t: string; id: number; name: string; input: unknown; text: string; value?: string; error?: string }) => {
      if (m.t === 'log') logs.push(m.text)
      else if (m.t === 'done') finish(m.error === undefined ? null : new Error(m.error), m.value)
      else if (m.t === 'call') {
        const o = ops.find((o) => o.script === m.name)
        try {
          if (!o) throw new OpError(`No badger.${m.name}`)
          worker.postMessage({ id: m.id, value: await runForScript(o, m.input, ctx) })
        } catch (err) {
          if (!(err instanceof OpError)) console.error(`badger.${m.name} failed:`, err)
          worker.postMessage({ id: m.id, error: message(err) })
        }
      }
    })
    worker.on('error', (err: Error) => finish(err))
    worker.on('exit', () => finish(new Error('The script stopped without finishing.')))
  })
}
