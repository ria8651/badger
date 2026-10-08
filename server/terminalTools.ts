import { isAbsolute, resolve } from 'node:path'
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { TerminalInfo } from '../shared/protocol.ts'
import type { Terminals } from './terminals.ts'
import { workspaceRoot } from './workspace.ts'

export const TERMINAL_SERVER = 'terminals'

/** Reading is free; anything that runs, types or stops goes through the normal permission flow. */
export const TERMINAL_AUTO_ALLOWED = ['list_terminals', 'read_terminal'].map((t) => `mcp__${TERMINAL_SERVER}__${t}`)

const DEFAULT_LINES = 50
/** Without wait_for, how long to collect output after an action before replying. */
const SETTLE_MS = 1500
const MAX_RESULT_CHARS = 30_000

const id = z.string().describe('Terminal id from list_terminals')
const lines = z.number().int().min(1).max(1000).optional().describe(`Lines of output to return (default ${DEFAULT_LINES})`)
const waitFor = z
  .string()
  .optional()
  .describe('Regex to wait for in output that arrives after this call, e.g. "ready in|listening on". Matched without colours.')
const timeout = z.number().min(1).max(600).optional().describe('Seconds to wait for wait_for (default 30)')

/**
 * Badger's terminals as tools, for one chat. Terminals are the user's: they
 * see them in the browser, and they outlive this chat and Badger restarts.
 */
export function terminalServer(terminals: Terminals, sessionId: string, chatCwd: () => string): McpSdkServerConfigWithInstance {
  // The chat's directory moves if Claude enters a worktree; look its root up again when it does.
  let rootOf: [string, string] | undefined
  const root = () => {
    const cwd = chatCwd()
    if (rootOf?.[0] !== cwd) rootOf = [cwd, workspaceRoot(cwd)]
    return rootOf[1]
  }

  const find = (tid: string) => terminals.get(tid)

  /**
   * Do something, then wait for wait_for (or briefly settle) and report the
   * terminal's state and output. `target` is an id, or creates the terminal,
   * in which case output is listened for from before it exists.
   */
  async function act(
    target: string | (() => Promise<TerminalInfo>),
    opts: { lines?: number; wait_for?: string; timeout?: number },
    action: () => Promise<unknown> = async () => {},
    settle = SETTLE_MS,
    /** Only output after this line counts towards wait_for, e.g. the host's note that a restart happened. */
    after?: string,
  ) {
    let re: RegExp | undefined
    try {
      re = opts.wait_for ? new RegExp(opts.wait_for, 'm') : undefined
    } catch (err) {
      return error(`Invalid wait_for regex: ${err instanceof Error ? err.message : err}`)
    }
    let tid = typeof target === 'string' ? target : undefined
    const early: { id: string; data: string }[] = []
    let counting = !after
    let seen = ''
    let armed = false
    let outcome = ''
    let finish: (why: string) => void = () => {}
    const see = (data: string) => {
      let text = stripAnsi(data)
      if (!counting) {
        const at = text.indexOf(after!)
        if (at < 0) return
        counting = true
        text = text.slice(at + after!.length)
      }
      seen = (seen + text).slice(-64 * 1024)
      if (re?.test(seen)) finish(`Matched /${opts.wait_for}/.`)
    }
    await new Promise<void>((done) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      finish = (why: string) => {
        outcome ||= why
        off()
        clearTimeout(timer)
        done()
      }
      const off = terminals.on((e) => {
        if (e.type === 'output' && re) {
          if (!tid) early.push(e)
          else if (e.id === tid) see(e.data)
        }
        // A restart passes through "not running"; only count an exit once the action is done.
        if (e.type === 'terminals' && armed && !find(tid!)?.running) finish(find(tid!) ? 'The process exited.' : 'The terminal was closed.')
      })
      const ready = typeof target === 'string' ? Promise.resolve() : target().then((t) => void (tid = t.id))
      ready
        .then(() => {
          for (const e of early) if (e.id === tid) see(e.data)
          return action()
        })
        .then(
          () => {
            armed = true
            if (!find(tid!)?.running) return finish('')
            // The clock starts once the action is done: a stop can take seconds, and reporting
            // mid-restart would show the old process's state and invite a second restart.
            timer = setTimeout(
              () => finish(re ? `Timed out after ${opts.timeout ?? 30}s waiting for /${opts.wait_for}/.` : ''),
              re ? (opts.timeout ?? 30) * 1000 : settle,
            )
          },
          (err) => finish(`Failed: ${err instanceof Error ? err.message : err}`),
        )
    })
    if (!tid) return error(outcome)
    const t = find(tid)
    if (!t) return text([outcome, `Terminal ${tid} is closed.`].filter(Boolean).join('\n'))
    const output = await terminals.text(tid, opts.lines ?? DEFAULT_LINES).catch(() => '')
    return text([outcome, describe(t), '', output ? clip(output) : '(no output)'].filter((l, i) => i > 0 || l).join('\n'))
  }

  const describe = (t: TerminalInfo) => {
    const state = t.running ? 'running' : t.signal ? `killed (signal ${t.signal})` : `exited ${t.exitCode ?? '?'}`
    const what = t.command ? `$ ${t.command}` : `shell, showing "${t.title}"`
    const where = t.root === root() ? (t.cwd === root() ? '' : ` in ${t.cwd}`) : ` in ${t.cwd} (another workspace)`
    return `${t.id} [${state}] ${what}${where}${t.sessionId === sessionId ? ' (started by this chat)' : ''}`
  }

  const missing = (tid: string) => error(`No terminal ${tid}. Use list_terminals.`)

  return createSdkMcpServer({
    name: TERMINAL_SERVER,
    alwaysLoad: true,
    instructions: [
      "Badger has terminals the user can see and type into in the browser. They belong to the user's workspace, not this chat: they keep running across chats and Badger restarts, and the user may already have dev servers running in them.",
      'For anything long-running (dev servers, watchers, tails), use start_terminal rather than a background Bash command, so the user can see it and it outlives this chat. Check list_terminals first: if what you need is already running, read or restart that terminal instead of starting a second copy.',
      'Shell terminals the user opened can be driven with send_input, but they may be in the middle of something; prefer reading them.',
    ].join('\n'),
    tools: [
      tool(
        'list_terminals',
        "List Badger's terminals: id, state, command, directory. Ones in this chat's workspace come first.",
        {},
        async () => {
          const all = [...terminals.terminals].sort((a, b) => Number(b.root === root()) - Number(a.root === root()))
          return text(all.length ? all.map(describe).join('\n') : 'No terminals.')
        },
        { annotations: { readOnlyHint: true } },
      ),
      tool(
        'read_terminal',
        "Read a terminal's recent output as plain text. With wait_for, first waits for new output matching it.",
        { id, lines, wait_for: waitFor, timeout },
        async (args) => (find(args.id) ? act(args.id, args, undefined, 0) : missing(args.id)),
        { annotations: { readOnlyHint: true } },
      ),
      tool(
        'start_terminal',
        "Run a command in a new terminal the user can see, e.g. a dev server. It runs with bash -c and keeps running after this chat ends. Returns its first output; use wait_for to wait until it's ready.",
        {
          command: z.string().min(1),
          cwd: z.string().optional().describe("Directory to run in, absolute or relative to this chat's directory. Defaults to this chat's directory."),
          lines,
          wait_for: waitFor,
          timeout,
        },
        async (args) => {
          const dir = args.cwd ? (isAbsolute(args.cwd) ? args.cwd : resolve(chatCwd(), args.cwd)) : chatCwd()
          return act(() => terminals.create({ cwd: dir, command: args.command, sessionId }), args)
        },
      ),
      tool(
        'send_input',
        'Type into a terminal, e.g. press Enter to reload a dev server that asks for it, or answer a prompt. Enter is pressed after the text unless enter is false.',
        {
          id,
          text: z.string().optional().describe('Text to type'),
          enter: z.boolean().optional().describe('Press Enter after the text (default true)'),
          interrupt: z.boolean().optional().describe('Press Ctrl-C first'),
          lines,
          wait_for: waitFor,
          timeout,
        },
        async (args) => {
          if (!find(args.id)) return missing(args.id)
          if (!find(args.id)!.running) return error(`Terminal ${args.id} is not running; use restart_terminal.`)
          return act(args.id, args, async () => {
            if (args.interrupt) terminals.input(args.id, '\x03')
            const data = (args.text ?? '') + (args.enter === false ? '' : '\r')
            if (data) terminals.input(args.id, data)
          })
        },
      ),
      tool(
        'restart_terminal',
        'Stop the process in a terminal (and everything it started) and run it again: the same command, or a fresh shell.',
        { id, lines, wait_for: waitFor, timeout },
        async (args) => (find(args.id) ? act(args.id, args, () => terminals.restart(args.id), SETTLE_MS, '[restarted]') : missing(args.id)),
        { annotations: { idempotentHint: true } },
      ),
      tool(
        'stop_terminal',
        'Stop the process in a terminal and everything it started. The terminal stays, with its output, until closed; close also removes it.',
        { id, close: z.boolean().optional().describe('Also remove the terminal') },
        async (args) => {
          if (!find(args.id)) return missing(args.id)
          try {
            if (args.close) await terminals.remove(args.id)
            else await terminals.stop(args.id)
          } catch (err) {
            return error(err instanceof Error ? err.message : String(err))
          }
          return text(args.close ? `Closed terminal ${args.id}.` : `Stopped terminal ${args.id}.`)
        },
        { annotations: { destructiveHint: true } },
      ),
    ],
  })
}

/** Colours, cursor movement and titles out; what's left reads like the screen. */
function stripAnsi(s: string): string {
  return s.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-_]/g, '').replace(/\r(?!\n)/g, '\n')
}

function clip(s: string): string {
  return s.length > MAX_RESULT_CHARS ? '[earlier output cut]\n' + s.slice(-MAX_RESULT_CHARS) : s
}

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] })
const error = (t: string) => ({ content: [{ type: 'text' as const, text: t }], isError: true })
