import { randomUUID } from 'node:crypto'
import type { CanUseTool, PermissionResult, PermissionUpdate } from '@anthropic-ai/claude-agent-sdk'
import type { AnswerDraft, PendingPermission, ServerEvent } from '../../shared/protocol.ts'
import { SCRIPT_TOOL } from '../scripts.ts'

interface Pending extends PendingPermission {
  suggestions?: PermissionUpdate[]
  resolve: (result: PermissionResult) => void
}

/**
 * A chat's permission prompts and questions waiting on the user. Claude Code
 * asks through `canUseTool`, which waits until the user answers, the turn is
 * interrupted, or Claude Code stops waiting. Every viewer sees each one come
 * and go, and the answers drafted so far.
 */
export class Permissions {
  private pending = new Map<string, Pending>()

  constructor(
    private sessionId: string,
    private emit: (event: ServerEvent) => void,
    private hooks: {
      /** A call reached the prompt: whatever auto mode thought of it, it's decided. */
      asked: (toolUseId: string) => void
      /** A subagent's description, to say which one is asking. */
      agent: (agentId: string) => string | undefined
    },
  ) {}

  canUseTool: CanUseTool = (toolName, input, { signal, suggestions: offered, blockedPath, toolUseID, agentID }) =>
    new Promise<PermissionResult>((resolve) => {
      this.hooks.asked(toolUseID)
      // A script can do what any of Badger's tools can, so allowing scripts for good would allow all of them, unasked.
      const suggestions = toolName.endsWith(`__${SCRIPT_TOOL}`) ? undefined : offered
      const requestId = randomUUID()
      const done = (result: PermissionResult) => {
        if (!this.pending.delete(requestId)) return
        this.emit({ type: 'permission_resolved', sessionId: this.sessionId, requestId })
        resolve(result)
      }
      const pending: Pending = {
        requestId,
        toolName,
        toolUseId: toolUseID,
        input,
        blockedPath,
        suggestions,
        canAlwaysAllow: !!suggestions?.length,
        ...(agentID ? { agent: this.hooks.agent(agentID) ?? 'A subagent' } : {}),
        resolve: done,
      }
      this.pending.set(requestId, pending)
      signal.addEventListener('abort', () => done({ behavior: 'deny', message: 'Aborted' }), { once: true })
      this.emit({ type: 'permission_request', sessionId: this.sessionId, permission: publicPermission(pending) })
    })

  resolve(requestId: string, decision: 'allow' | 'allow_always' | 'deny', message?: string, updatedInput?: Record<string, unknown>): void {
    const p = this.pending.get(requestId)
    if (!p) return
    if (decision === 'deny') {
      p.resolve({ behavior: 'deny', message: message || 'The user denied this action.' })
    } else {
      p.resolve({
        behavior: 'allow',
        updatedInput: updatedInput ?? p.input,
        ...(decision === 'allow_always' && p.suggestions ? { updatedPermissions: p.suggestions } : {}),
      })
    }
  }

  /** Denies every one, stopping the turn: the user interrupted it. */
  interrupt(): void {
    for (const p of this.pending.values()) p.resolve({ behavior: 'deny', message: 'Interrupted by user', interrupt: true })
  }

  /** Keeps answers picked so far with the pending question. False if it's no longer pending. */
  draftAnswers(requestId: string, answers: AnswerDraft): boolean {
    const p = this.pending.get(requestId)
    if (!p) return false
    p.answers = answers
    return true
  }

  /** Keeps the plan as edited so far with the pending ExitPlanMode. False if it's no longer pending. */
  draftPlan(requestId: string, plan: string): boolean {
    const p = this.pending.get(requestId)
    if (!p || p.toolName !== 'ExitPlanMode') return false
    p.plan = plan
    return true
  }

  list(): PendingPermission[] {
    return [...this.pending.values()].map(publicPermission)
  }

  get waiting(): boolean {
    return this.pending.size > 0
  }
}

function publicPermission({ resolve: _r, suggestions: _s, ...rest }: Pending): PendingPermission {
  return rest
}
