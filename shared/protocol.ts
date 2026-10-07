/**
 * Wire protocol between the browser and the server over a single WebSocket.
 * SDK messages are forwarded mostly verbatim; the client renders them.
 */

export type PermissionMode = 'default' | 'acceptEdits' | 'auto' | 'plan' | 'bypassPermissions'

export interface PendingPermission {
  requestId: string
  toolName: string
  toolUseId?: string
  input: Record<string, unknown>
  /** True when the SDK offered rules that would make this an "always allow". */
  canAlwaysAllow: boolean
  blockedPath?: string
}

export interface SessionSummary {
  id: string
  title: string
  cwd?: string
  lastModified: number
  running: boolean
}

/** Anything the SDK emits, or a transcript entry read back from disk. */
export type WireMessage = { type: string; uuid?: string; [key: string]: unknown }

export type ClientEvent =
  | { type: 'subscribe'; sessionId: string }
  | { type: 'unsubscribe'; sessionId: string }
  | { type: 'send'; sessionId: string; text: string; cwd?: string; mode?: PermissionMode }
  | { type: 'interrupt'; sessionId: string }
  | { type: 'set_mode'; sessionId: string; mode: PermissionMode }
  | {
      type: 'permission'
      sessionId: string
      requestId: string
      decision: 'allow' | 'allow_always' | 'deny'
      message?: string
      /** Replacement tool input, e.g. AskUserQuestion answers. */
      updatedInput?: Record<string, unknown>
    }

export type ServerEvent =
  | {
      type: 'snapshot'
      sessionId: string
      messages: WireMessage[]
      running: boolean
      mode: PermissionMode
      cwd?: string
      permissions: PendingPermission[]
      /** Output so far of Bash commands still running, by tool_use_id. */
      bashOutput: Record<string, string>
    }
  | { type: 'message'; sessionId: string; message: WireMessage }
  /** Live output from a running Bash command; the tool_result still carries the final output. */
  | { type: 'bash_output'; sessionId: string; toolUseId: string; chunk: string }
  | { type: 'status'; sessionId: string; running: boolean; mode: PermissionMode }
  | { type: 'permission_request'; sessionId: string; permission: PendingPermission }
  | { type: 'permission_resolved'; sessionId: string; requestId: string }
  | { type: 'sessions_changed' }
  | { type: 'error'; sessionId?: string; error: string }
