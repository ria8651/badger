import { connect } from 'node:net'
import { z } from 'zod'
import type { Bridges } from './bridge.ts'
import { op, type Op } from './ops.ts'
import { TERMINAL_SERVER } from './terminalTools.ts'
import { workspaceRoot } from './workspace.ts'

export const PREVIEW_INSTRUCTIONS = [
  "To show the user a web page a dev server serves, use open_preview: it opens in a panel beside this chat. The user may be on another computer or a phone, so give them preview URLs, never localhost ones.",
  "The preview_* tools work in the page the user has open, with their login and whatever state it's in: run code in it, read its console, screenshot it, navigate it. Use them when the user says something's broken there, or to set up a state for them to try.",
  ...(process.env.BADGER_CHROMIUM
    ? [
        `To check a page yourself, with nobody watching, Playwright and a headless Chromium are installed: \`require('playwright-core').chromium.launch({ executablePath: '${process.env.BADGER_CHROMIUM}', args: ['--no-sandbox'] })\` in a node script. Dev servers are at http://localhost:<port>. Save screenshots to files and Read them; the user sees them too. It has its own cookies and state, not the user's: for their page, use the preview_* tools.`,
      ]
    : []),
]

/** Showing what a port serves in the user's browser. */
export interface Previews {
  /** Shows it in the panels of every browser tab on that workspace; returns how many tabs are connected. */
  open(root: string, port: number, name?: string, path?: string): number
  /** The address a browser opens it at, once one has said where previews are. */
  url(port: number, path?: string): string | undefined
}

const port = z.number().int().min(1).max(65535)
const timeout = z.number().min(1).max(600).optional().describe('Seconds to wait for the page (default 30)')

const RUN_HELP = `Run JavaScript in the page the user has open, and get its result. The code runs as an async function: an expression gives its value, a body can \`return\` one, and \`await\` works. Elements come back as their tag and text, other values as JSON. Helpers in scope:
- $(sel), $$(sel): querySelector, querySelectorAll (as an array)
- click(sel|el): a full pointer/mouse click; scrolls it into view first
- fill(sel|el, text): replace a field's value, in a way React etc. notice
- press(key, sel?): keydown/keyup; Enter in a form field submits it
- waitFor(sel|fn, ms?): until it finds something (default 5000ms)
- text(sel?): innerText of the element, or the whole page
- sleep(ms)
This acts on the user's real page: clicking can change their real data.`

/** Showing previews, and the bridge into the pages the user has open. */
export function previewOps(previews: Previews, bridges: Bridges): Op[] {
  const s = { server: TERMINAL_SERVER }
  return [
    op({
      ...s,
      tool: 'open_preview',
      script: 'preview.open',
      description:
        "Show what a port on this machine serves, e.g. a dev server, in a panel beside this chat in the user's browser. Returns the preview's URL, which works in its own browser tab too. Opening a port that's already showing navigates it to path and reloads it.",
      input: {
        port,
        name: z.string().optional().describe('Tab label, e.g. "Storefront" or "Storybook". Defaults to the port.'),
        path: z.string().optional().describe('Path to open, e.g. "/settings". Defaults to "/".'),
      },
      returns: '{ url?, tabs, listening }',
      autoAllow: true,
      annotations: { readOnlyHint: true },
      async run(args, ctx) {
        const path = args.path ? (args.path.startsWith('/') ? args.path : `/${args.path}`) : '/'
        const listening = await isListening(args.port)
        const tabs = previews.open(workspaceRoot(ctx.cwd()), args.port, args.name, path)
        const url = previews.url(args.port, path)
        const text = [
          tabs ? `Opened in the panels of ${tabs === 1 ? 'the browser tab' : `${tabs} browser tabs`} showing Badger.` : 'No browser has Badger open, so nothing was shown.',
          url ? `URL: ${url}` : '',
          listening ? '' : `Nothing is listening on port ${args.port} yet; the preview loads once something does.`,
        ]
        return { text: text.filter(Boolean).join('\n'), value: { url, tabs, listening } }
      },
    }),
    op({
      ...s,
      tool: 'preview_pages',
      script: 'preview.pages',
      description: 'List the preview pages the user has open, in Badger or in browser tabs, most recently used first.',
      input: {},
      returns: '{ port, url, title, visible, idle }[], idle in seconds since the user last did something there',
      autoAllow: true,
      annotations: { readOnlyHint: true },
      async run() {
        const pages = bridges.list()
        const text = pages.map((p) => `${p.port}  ${p.url}  ${JSON.stringify(p.title)}${p.visible ? '' : ' (hidden)'}  used ${p.idle}s ago`)
        return { text: text.join('\n') || 'No preview pages are open. open_preview shows one.', value: pages }
      },
    }),
    op({
      ...s,
      tool: 'preview_run',
      script: 'preview.run',
      description: RUN_HELP,
      input: { port, code: z.string().min(1).describe('JavaScript; in scripts, a function works too'), timeout },
      returns: 'the result as data (elements as strings)',
      async run(args) {
        const { url, value } = await bridges.call(args.port, { op: 'run', code: args.code }, seconds(args.timeout))
        const r = value as { text: string; data: unknown }
        return { text: `${r.text}\n\n(in ${url})`, value: r.data }
      },
    }),
    op({
      ...s,
      tool: 'preview_logs',
      script: 'preview.logs',
      description: "The page's console output and errors (including failed loads) since it loaded.",
      input: { port, clear: z.boolean().optional().describe('Clear them after reading, so the next read shows only new ones') },
      returns: '{ at, level, text }[], at in ms since the epoch',
      autoAllow: true,
      annotations: { readOnlyHint: true },
      async run(args) {
        const { value } = await bridges.call(args.port, { op: 'logs' }, seconds())
        if (args.clear) await bridges.call(args.port, { op: 'clear_logs' }, seconds())
        const logs = (value as { at: number; level: string; text: string }[]).map(({ at, level, text }) => ({ at, level, text }))
        const lines = logs.map((l) => `${new Date(l.at).toISOString().slice(11, 23)} ${l.level.padEnd(5)} ${l.text}`)
        return { text: lines.join('\n') || '(no console output)', value: logs }
      },
    }),
    op({
      ...s,
      tool: 'preview_screenshot',
      script: 'preview.screenshot',
      description:
        "Render the page the user has open to an image: what's on screen, one element, or the whole page. It's redrawn from the DOM, not captured, so canvas/WebGL, some CSS and cross-origin images can come out wrong; check computed styles with preview_run when it matters.",
      input: {
        port,
        selector: z.string().optional().describe('Just this element'),
        full: z.boolean().optional().describe('The whole page, not only what fits on screen'),
        timeout,
      },
      returns: 'the PNG file path',
      autoAllow: true,
      annotations: { readOnlyHint: true },
      async run(args) {
        const { url, value } = await bridges.call(args.port, { op: 'screenshot', selector: args.selector, full: args.full }, seconds(args.timeout))
        const data = String(value)
        return { text: `Screenshot of ${url}`, image: data.slice(data.indexOf(',') + 1) }
      },
    }),
    op({
      ...s,
      tool: 'preview_goto',
      script: 'preview.goto',
      description: 'Navigate the page the user has open, and wait for the new page.',
      input: { port, url: z.string().min(1).describe('A path like /settings, or a full URL'), timeout },
      returns: '{ url }',
      async run(args) {
        const { url } = await bridges.call(args.port, { op: 'goto', url: args.url }, seconds(args.timeout))
        return { text: `Now at ${url}`, value: { url } }
      },
    }),
  ]
}

const seconds = (s = 30) => s * 1000

function isListening(port: number): Promise<boolean> {
  return new Promise((done) => {
    const s = connect({ host: 'localhost', port })
    const finish = (ok: boolean) => (s.destroy(), done(ok))
    s.setTimeout(1000, () => finish(false))
    s.once('connect', () => finish(true))
    s.once('error', () => finish(false))
  })
}
