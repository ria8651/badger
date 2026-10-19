import type { AttentionState, ServerEvent } from '../shared/protocol.ts'
import type { ChatMeta } from './chatMeta.ts'

/**
 * Which chats need the user. Waiting comes from live sessions' pending
 * prompts, so it goes when the process does; unread is stored, so it
 * survives restarts. A child chat's prompts show in its parent, so they
 * count as the parent's; a child's turn ending is its parent's business.
 */
export class Attention {
  private last = ''

  constructor(
    private meta: ChatMeta,
    /** Live chats with a prompt or question waiting, on every machine. */
    private waiting: () => string[],
    private broadcast: (event: ServerEvent) => void,
  ) {}

  /** Call with every event a live chat emits. */
  see(e: ServerEvent): void {
    if (e.type === 'permission_request' || e.type === 'permission_resolved') this.update()
    else if (e.type === 'error' && e.sessionId && !this.meta.parentOf(e.sessionId)) this.mark(e.sessionId, true)
  }

  /** A chat's turn ended. Not when Claude Code is holding messages that start the next one. */
  turnEnded(sessionId: string, queued: boolean): void {
    if (!queued && !this.meta.parentOf(sessionId)) this.mark(sessionId, true)
  }

  mark(sessionId: string, unread: boolean): void {
    if (this.meta.setUnread(sessionId, unread)) this.update()
  }

  chats(): Record<string, AttentionState> {
    const chats: Record<string, AttentionState> = {}
    for (const id of this.meta.unreadIds()) chats[id] = 'unread'
    for (const id of this.waiting()) chats[this.root(id)] = 'waiting'
    return chats
  }

  /** Tells every tab if anything changed. Also call when a session closes or its machine goes, taking its prompts with it. */
  update(): void {
    const chats = this.chats()
    const json = JSON.stringify(chats)
    if (json === this.last) return
    this.last = json
    this.broadcast({ type: 'attention', chats })
  }

  private root(id: string): string {
    const seen = new Set<string>()
    for (let parent = this.meta.parentOf(id); parent && !seen.has(parent); parent = this.meta.parentOf(parent)) {
      seen.add(id)
      id = parent
    }
    return id
  }
}
