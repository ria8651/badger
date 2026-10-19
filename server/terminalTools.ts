import { isAbsolute, resolve } from 'node:path'
import { z } from 'zod'
import type { TerminalInfo } from '../shared/protocol.ts'
import { OpError, op, type Op, type OpContext, type OpResult } from './ops.ts'
import type { Terminals } from './terminals.ts'
import { workspaceRoot } from './workspace.ts'

export const TERMINAL_SERVER = 'terminals'

export const TERMINAL_INSTRUCTIONS = [
  "Badger has terminals the user can see and type into in the browser. They belong to the user's workspace, not this chat: they keep running across chats and Badger restarts, and the user may already have dev servers running in them.",
  'For anything long-running (dev servers, watchers, tails), use start_terminal rather than a background Bash command, so the user can see it and it outlives this chat. Check list_terminals first: if what you need is already running, read or restart that terminal instead of starting a second copy.',
  'Shell terminals the user opened can be driven with send_input, but they may be in the middle of something; prefer reading them.',
]

const DEFAULT_LINES = 50
/** Without wait_for, how long to collect output after an action before replying. */
const SETTLE_MS = 1500
const MAX_RESULT_CHARS = 30_000

const id = z.string().describe('Terminal id from list_terminals')
const lines = z.number().int().min(1).max(1000).optional().describe(`Lines of output to return (default ${DEFAULT_LINES})`)
const waitFor = z
  .string()
  .optional()
  .describe(
    'Regex to wait for in output that arrives after this call, e.g. "ready in|listening on|error". Matched without colours. Include failure patterns too, so a failure ends the wait instead of waiting out max_wait.',
  )
const maxWait = z
  .number()
  .min(1)
  .max(600)
  .optional()
  .describe(
    'Seconds to wait for wait_for (default 30). Running out only stops waiting: the process keeps running. Set about as long as it should take, then read_terminal to check on it and wait again if it is still going.',
  )

const TERMINAL = 'Terminal = { id, title, name?, cwd, root, command?, sessionId?, running, pid?, ports?, exitCode?, signal?, createdAt }'
const ACTED = `{ outcome, terminal?: Terminal, output }. ${TERMINAL}`

/**
 * Badger's terminals. Terminals are the user's: they see them in the
 * browser, and they outlive the chat and Badger restarts.
 */
export function terminalOps(terminals: Terminals): Op[] {
  // A chat's directory moves if Claude enters a worktree; look its root up again when it does.
  const roots = new Map<string, string>()
  const root = (ctx: OpContext) => {
    const cwd = ctx.cwd()
    if (!roots.has(cwd)) roots.set(cwd, workspaceRoot(cwd))
    return roots.get(cwd)!
  }

  const find = (tid: string) => terminals.get(tid)
  const need = (tid: string) => find(tid) ?? fail(`No terminal ${tid}. Use list_terminals.`)

  /**
   * Do something, then wait for wait_for (or briefly settle) and report the
   * terminal's state and output. `target` is an id, or creates the terminal,
   * in which case output is listened for from before it exists.
   */
  async function act(
    ctx: OpContext,
    target: string | (() => Promise<TerminalInfo>),
    opts: { lines?: number; wait_for?: string; max_wait?: number },
    action: () => Promise<unknown> = async () => {},
    settle = SETTLE_MS,
    /** Only output after this line counts towards wait_for, e.g. the host's note that a restart happened. */
    after?: string,
  ): Promise<OpResult> {
    let re: RegExp | undefined
    try {
      re = opts.wait_for ? new RegExp(opts.wait_for, 'm') : undefined
    } catch (err) {
      fail(`Invalid wait_for regex: ${err instanceof Error ? err.message : err}`)
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
        ctx.signal?.removeEventListener('abort', stop)
        done()
      }
      const stop = () => finish('Stopped waiting.')
      ctx.signal?.addEventListener('abort', stop)
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
              () => finish(re ? `Gave up after ${opts.max_wait ?? 30}s waiting for /${opts.wait_for}/.` : ''),
              re ? (opts.max_wait ?? 30) * 1000 : settle,
            )
          },
          (err) => finish(`Failed: ${err instanceof Error ? err.message : err}`),
        )
    })
    if (!tid) fail(outcome)
    const t = find(tid!)
    if (!t) return { text: [outcome, `Terminal ${tid} is closed.`].filter(Boolean).join('\n'), value: { outcome, output: '' } }
    const output = clip(await terminals.text(tid!, opts.lines ?? DEFAULT_LINES).catch(() => ''))
    return {
      text: [outcome, describe(t, ctx), '', output || '(no output)'].filter((l, i) => i > 0 || l).join('\n'),
      value: { outcome, terminal: t, output },
    }
  }

  const describe = (t: TerminalInfo, ctx: OpContext) => {
    const state = t.running ? 'running' : t.signal ? `killed (signal ${t.signal})` : `exited ${t.exitCode ?? '?'}`
    const what = `${t.name ? `"${t.name}" ` : ''}${t.command ? `$ ${t.command}` : `shell, showing "${t.title}"`}`
    const here = root(ctx)
    const where = t.root === here ? (t.cwd === here ? '' : ` in ${t.cwd}`) : ` in ${t.cwd} (another workspace)`
    const ports = t.ports?.length ? `, listening on ${t.ports.join(', ')}` : ''
    return `${t.id} [${state}${ports}] ${what}${where}${t.sessionId === ctx.sessionId ? ' (started by this chat)' : ''}`
  }

  const s = { server: TERMINAL_SERVER }

  return [
    op({
      ...s,
      tool: 'list_terminals',
      script: 'terminals.list',
      description: "List Badger's terminals: id, state, command, directory. Ones in this chat's workspace come first.",
      input: {},
      returns: `Terminal[]. ${TERMINAL}`,
      autoAllow: true,
      annotations: { readOnlyHint: true },
      async run(_args, ctx) {
        const here = root(ctx)
        const all = [...terminals.terminals].sort((a, b) => Number(b.root === here) - Number(a.root === here))
        return { text: all.length ? all.map((t) => describe(t, ctx)).join('\n') : 'No terminals.', value: all }
      },
    }),
    op({
      ...s,
      tool: 'read_terminal',
      script: 'terminals.read',
      description: "Read a terminal's recent output as plain text. With wait_for, first waits for new output matching it.",
      input: { id, lines, wait_for: waitFor, max_wait: maxWait },
      returns: ACTED,
      autoAllow: true,
      annotations: { readOnlyHint: true },
      run: (args, ctx) => (need(args.id), act(ctx, args.id, args, undefined, 0)),
    }),
    op({
      ...s,
      tool: 'start_terminal',
      script: 'terminals.start',
      description:
        "Run a command in a new terminal the user can see, e.g. a dev server. It runs with bash -c and keeps running after this chat ends. Returns its first output; use wait_for to wait until it's ready.",
      input: {
        command: z.string().min(1),
        name: z
          .string()
          .max(40)
          .optional()
          .describe('What it\'s called in the terminal list: a word or two for what it is, e.g. "Dev server" or "Storybook". Without one, the command shows.'),
        cwd: z.string().optional().describe("Directory to run in, absolute or relative to this chat's directory. Defaults to this chat's directory."),
        lines,
        wait_for: waitFor,
        max_wait: maxWait,
      },
      returns: ACTED,
      async run(args, ctx) {
        const dir = args.cwd ? (isAbsolute(args.cwd) ? args.cwd : resolve(ctx.cwd(), args.cwd)) : ctx.cwd()
        return act(ctx, () => terminals.create({ cwd: dir, command: args.command, name: args.name, sessionId: ctx.sessionId || undefined }), args)
      },
    }),
    op({
      ...s,
      tool: 'send_input',
      script: 'terminals.input',
      description:
        'Type into a terminal, e.g. press Enter to reload a dev server that asks for it, or answer a prompt. Enter is pressed after the text unless enter is false.',
      input: {
        id,
        text: z.string().optional().describe('Text to type'),
        enter: z.boolean().optional().describe('Press Enter after the text (default true)'),
        interrupt: z.boolean().optional().describe('Press Ctrl-C first'),
        lines,
        wait_for: waitFor,
        max_wait: maxWait,
      },
      returns: ACTED,
      async run(args, ctx) {
        if (!need(args.id).running) fail(`Terminal ${args.id} is not running; use restart_terminal.`)
        return act(ctx, args.id, args, async () => {
          if (args.interrupt) terminals.input(args.id, '\x03')
          const data = (args.text ?? '') + (args.enter === false ? '' : '\r')
          if (data) terminals.input(args.id, data)
        })
      },
    }),
    op({
      ...s,
      tool: 'restart_terminal',
      script: 'terminals.restart',
      description: 'Stop the process in a terminal (and everything it started) and run it again: the same command, or a fresh shell.',
      input: { id, lines, wait_for: waitFor, max_wait: maxWait },
      returns: ACTED,
      annotations: { idempotentHint: true },
      run: (args, ctx) => (need(args.id), act(ctx, args.id, args, () => terminals.restart(args.id), SETTLE_MS, '[restarted]')),
    }),
    op({
      ...s,
      tool: 'stop_terminal',
      script: 'terminals.stop',
      description: 'Stop the process in a terminal and everything it started. The terminal stays, with its output, until closed; close also removes it.',
      input: { id, close: z.boolean().optional().describe('Also remove the terminal') },
      returns: '{ id, closed }',
      annotations: { destructiveHint: true },
      async run(args) {
        need(args.id)
        if (args.close) await terminals.remove(args.id)
        else await terminals.stop(args.id)
        return { text: args.close ? `Closed terminal ${args.id}.` : `Stopped terminal ${args.id}.`, value: { id: args.id, closed: !!args.close } }
      },
    }),
  ]
}

const fail = (message: string): never => {
  throw new OpError(message)
}

/** Colours, cursor movement and titles out; what's left reads like the screen. */
function stripAnsi(s: string): string {
  return s.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-_]/g, '').replace(/\r(?!\n)/g, '\n')
}

function clip(s: string): string {
  return s.length > MAX_RESULT_CHARS ? '[earlier output cut]\n' + s.slice(-MAX_RESULT_CHARS) : s
}
