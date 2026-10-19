import { tool, type AnyZodRawShape, type InferShape, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk'
import type { LiveSession, SessionManager } from './session.ts'

export interface ChildResult {
  sessionId: string
  /** The turn ended normally, as opposed to being interrupted or failing. */
  ok: boolean
  /** The child's final reply, or what went wrong. */
  text: string
}

/**
 * Chats that another chat starts and waits on, like a subagent but a full
 * Claude Code session with its own directory. Started from a tool call, which
 * blocks until the child's first turn ends and returns its reply. Children
 * stay out of the sidebar; the client shows each inside its parent's tool call.
 * A child runs on its parent's machine; the hub puts it there and gives it its id.
 */
export class Children {
  constructor(
    private manager: SessionManager,
    /** Asks the hub for a new child of a chat on this machine; resolves to its id. */
    private start: (child: { parentId: string; toolUseId: string; kind: string }) => Promise<string>,
  ) {}

  async run(
    parent: LiveSession,
    opts: { toolUseId: string; kind: string; cwd: string; prompt: string; signal?: AbortSignal },
  ): Promise<ChildResult> {
    const sessionId = await this.start({ parentId: parent.id, toolUseId: opts.toolUseId, kind: opts.kind })
    // A child can't propose a plan back to its parent, so plan mode falls back to asking.
    const child = await this.manager.open(sessionId, { cwd: opts.cwd, mode: parent.mode === 'plan' ? 'default' : parent.mode, model: parent.model })
    parent.emitEvent({ type: 'child_started', sessionId: parent.id, toolUseId: opts.toolUseId, childId: sessionId })

    return new Promise((resolve) => {
      const onAbort = () => void child.interrupt()
      const finish = (ok: boolean, text: string) => {
        off()
        opts.signal?.removeEventListener('abort', onAbort)
        resolve({ sessionId, ok, text })
      }
      const off = child.subscribe((e) => {
        if (e.type === 'message' && e.message.type === 'result') {
          const m = e.message
          const ok = m.subtype === 'success' && !m.is_error
          finish(ok, String(m.result ?? (ok ? '' : `Stopped: ${m.subtype}`)))
        } else if (e.type === 'error') finish(false, e.error)
      })
      // Stopped while the child was being set up: it never gets its prompt.
      if (opts.signal?.aborted) return finish(false, 'Stopped before it started.')
      opts.signal?.addEventListener('abort', onAbort, { once: true })
      if (!child.send(opts.prompt)) finish(false, 'The chat closed before it could start.')
    })
  }
}

/** What a tool call shows Claude. */
export type ToolReply = { content: { type: 'text'; text: string }[]; isError?: boolean }

export const reply = (text: string): ToolReply => ({ content: [{ type: 'text', text }] })
export const refuse = (text: string): ToolReply => ({ ...reply(text), isError: true })

/** A child tool's call: the chat that made it, where that chat is now, and its child to start. */
export interface ChildCall {
  parent: LiveSession
  dir: string
  /** Starts the child in `cwd` and waits for its first turn to end. Stopping the call stops it. */
  child: (cwd: string, prompt: string) => Promise<ChildResult>
}

/**
 * A tool, for one chat, whose work a child chat does while that chat waits:
 * shown inside the call, which is found by `toolName`, Claude Code's full
 * name for the tool. `kind` says what the child is for, e.g. merge.
 */
export function childTool<S extends AnyZodRawShape>(
  def: { name: string; kind: string; description: string; input: S },
  deps: { manager: SessionManager; children: Children },
  chat: { sessionId: string; cwd: () => string; toolName: string },
  body: (args: InferShape<S>, call: ChildCall) => Promise<ToolReply>,
): SdkMcpToolDefinition<S> {
  return tool(def.name, def.description, def.input, async (args, extra) => {
    const parent = deps.manager.get(chat.sessionId)
    const toolUseId = parent?.takeToolUse(chat.toolName)
    if (!parent || !toolUseId) return refuse(`Badger couldn't find this tool call, so it can't show the ${def.kind}. Try again.`)
    const signal = (extra as { signal?: AbortSignal } | undefined)?.signal
    return body(args, {
      parent,
      dir: chat.cwd(),
      child: (cwd, prompt) => deps.children.run(parent, { toolUseId, kind: def.kind, cwd, prompt, signal }),
    })
  })
}
