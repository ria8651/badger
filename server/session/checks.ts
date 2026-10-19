import type { WireMessage } from '../../shared/protocol.ts'

/** Allowed in auto mode without asking the classifier. */
const READ_ONLY_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead', 'TodoWrite', 'ToolSearch', 'TaskOutput'])

/**
 * The calls auto mode's classifier is still deciding on, so viewers can show
 * them as being checked. Each is tracked from when Claude makes it until it's
 * decided one way or another; every change goes to `changed`.
 */
export class AutoChecks {
  /** tool_use_id to the subagent's call it's in, or null for the chat's own. */
  private checking = new Map<string, string | null>()

  constructor(private changed: (toolUseIds: string[]) => void) {}

  ids(): string[] {
    return [...this.checking.keys()]
  }

  /**
   * The calls in a message Claude has just made go to the check. The chat's
   * own calls are followed until their message ends. A subagent's messages
   * don't stream here, so only its commands, which say when they start, are.
   */
  start(msg: WireMessage): void {
    const parent = (msg.parent_tool_use_id as string | null | undefined) ?? null
    const content = (msg.message as { content?: unknown } | undefined)?.content
    const uses = Array.isArray(content) ? (content as { type?: string; id?: string; name?: string }[]) : []
    let added = false
    for (const u of uses) {
      if (u.type !== 'tool_use' || !u.id || !u.name || READ_ONLY_TOOLS.has(u.name)) continue
      if (parent && u.name !== 'Bash') continue
      this.checking.set(u.id, parent)
      added = true
    }
    if (added) this.changed(this.ids())
  }

  /** A call is through the check, one way or another; without an id, every call. */
  done(toolUseId?: string): void {
    if (toolUseId ? !this.checking.delete(toolUseId) : !this.checking.size) return
    if (!toolUseId) this.checking.clear()
    this.changed(this.ids())
  }

  /** A message ended, so the check has decided on all of its calls: the chat's own, or a subagent's. */
  messageDone(parent: string | null): void {
    const ids = [...this.checking].filter(([, p]) => p === parent).map(([id]) => id)
    for (const id of ids) this.checking.delete(id)
    if (ids.length) this.changed(this.ids())
  }
}
