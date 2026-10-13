import type { AttentionState, ServerEvent } from '../shared/protocol.ts'
import type { Store } from './db.ts'
import type { LiveSession, SessionManager } from './session.ts'

/**
 * Which chats need the user. Waiting comes from live sessions' pending
 * prompts, so it goes when the process does; unread is stored, so it
 * survives restarts. A child chat's prompts show in its parent, so they
 * count as the parent's; a child's turn ending is its parent's business.
 */
export class Attention {
  private last = ''

  constructor(
    private store: Store,
    private manager: SessionManager,
    private broadcast: (event: ServerEvent) => void,
  ) {}

  /** Call for every session as it opens. */
  watch(session: LiveSession): void {
    session.subscribe((e) => {
      if (e.type === 'permission_request' || e.type === 'permission_resolved') this.update()
      // Not when Claude Code is holding messages that start the next turn.
      else if (e.type === 'message' && e.message.type === 'result' && !session.hasQueued && !this.store.parentOf(session.id)) this.mark(session.id, true)
      else if (e.type === 'error' && !this.store.parentOf(session.id)) this.mark(session.id, true)
    })
  }

  mark(sessionId: string, unread: boolean): void {
    if (this.store.setUnread(sessionId, unread)) this.update()
  }

  chats(): Record<string, AttentionState> {
    const chats: Record<string, AttentionState> = {}
    for (const id of this.store.unreadIds()) chats[id] = 'unread'
    for (const id of this.manager.liveIds()) if (this.manager.get(id)?.waiting) chats[this.root(id)] = 'waiting'
    return chats
  }

  /** Tells every tab if anything changed. Also call when a session closes, taking its prompts with it. */
  update(): void {
    const chats = this.chats()
    const json = JSON.stringify(chats)
    if (json === this.last) return
    this.last = json
    this.broadcast({ type: 'attention', chats })
  }

  private root(id: string): string {
    const seen = new Set<string>()
    for (let parent = this.store.parentOf(id); parent && !seen.has(parent); parent = this.store.parentOf(parent)) {
      seen.add(id)
      id = parent
    }
    return id
  }
}
