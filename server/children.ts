import { randomUUID } from 'node:crypto'
import type { Remote } from './peer.ts'
import type { HubApi } from './runnerProtocol.ts'
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
 * A child runs on its parent's machine; the hub records it.
 */
export class Children {
  constructor(
    private manager: SessionManager,
    private hub: Remote<HubApi>,
  ) {}

  async run(
    parent: LiveSession,
    opts: { toolUseId: string; kind: string; cwd: string; prompt: string; signal?: AbortSignal },
  ): Promise<ChildResult> {
    const sessionId = randomUUID()
    // Recorded before the session exists, so the sidebar never lists it.
    await this.hub.addChild({ sessionId, parentId: parent.id, toolUseId: opts.toolUseId, kind: opts.kind })
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
      opts.signal?.addEventListener('abort', onAbort, { once: true })
      if (!child.send(opts.prompt)) finish(false, 'The chat closed before it could start.')
    })
  }
}
