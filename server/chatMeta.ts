import type { DraftAttachments } from '../shared/protocol.ts'
import type { Actor, Database } from './db.ts'

/** A chat's unsent composer contents. */
export type Draft = { text: string; attachments: DraftAttachments }

/**
 * What the hub keeps about each chat besides its transcript and card: its
 * draft, whether it's unread or archived, the chats it started and the one it
 * was forked from, and what it was last told about its card.
 */
export class ChatMeta {
  /** @param onArchived called whenever a chat is archived or unarchived, including by a card's status changing. */
  constructor(
    private db: Database,
    private onArchived: () => void = () => {},
  ) {}

  archivedIds(): Set<string> {
    const rows = this.db.sql.prepare('SELECT session_id FROM archived_sessions').all() as { session_id: string }[]
    return new Set(rows.map((r) => r.session_id))
  }

  /** Returns whether anything changed. In the audit log, like the board. */
  setArchived(sessionId: string, archived: boolean, actor: Actor): boolean {
    const changed = this.db.transaction(() => {
      const result = archived
        ? this.db.sql.prepare('INSERT INTO archived_sessions (session_id, archived_at) VALUES (?, ?) ON CONFLICT DO NOTHING').run(sessionId, Date.now())
        : this.db.sql.prepare('DELETE FROM archived_sessions WHERE session_id = ?').run(sessionId)
      if (result.changes > 0) this.db.audit(actor, 'archived_session', sessionId, archived ? 'archive' : 'unarchive', null, null)
      return result.changes > 0
    })
    if (changed) this.onArchived()
    return changed
  }

  draft(sessionId: string): Draft {
    const row = this.db.sql.prepare('SELECT text, attachments FROM session_drafts WHERE session_id = ?').get(sessionId) as
      | { text: string; attachments: string | null }
      | undefined
    return { text: row?.text ?? '', attachments: row?.attachments ? JSON.parse(row.attachments) : { pastes: [], images: [] } }
  }

  /** Replaces the parts of the draft given. An empty draft is deleted rather than stored. */
  setDraft(sessionId: string, change: Partial<Draft>): void {
    const saved = this.draft(sessionId)
    const text = change.text ?? saved.text
    const attachments = change.attachments ?? saved.attachments
    const attached = attachments.pastes.length > 0 || attachments.images.length > 0
    if (!text && !attached) this.db.sql.prepare('DELETE FROM session_drafts WHERE session_id = ?').run(sessionId)
    else
      this.db.sql
        .prepare(
          'INSERT INTO session_drafts (session_id, text, attachments, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET text = excluded.text, attachments = excluded.attachments, updated_at = excluded.updated_at',
        )
        .run(sessionId, text, attached ? JSON.stringify(attachments) : null, Date.now())
  }

  unreadIds(): Set<string> {
    const rows = this.db.sql.prepare('SELECT session_id FROM unread_sessions').all() as { session_id: string }[]
    return new Set(rows.map((r) => r.session_id))
  }

  /** Returns whether anything changed. */
  setUnread(sessionId: string, unread: boolean): boolean {
    const result = unread
      ? this.db.sql.prepare('INSERT INTO unread_sessions (session_id, at) VALUES (?, ?) ON CONFLICT DO NOTHING').run(sessionId, Date.now())
      : this.db.sql.prepare('DELETE FROM unread_sessions WHERE session_id = ?').run(sessionId)
    return result.changes > 0
  }

  /** The chat that started this one, if it's a child. */
  parentOf(sessionId: string): string | undefined {
    const row = this.db.sql.prepare('SELECT parent_session FROM child_sessions WHERE session_id = ?').get(sessionId) as { parent_session: string } | undefined
    return row?.parent_session
  }

  addChild(child: { sessionId: string; parentId: string; toolUseId: string; kind: string }): void {
    this.db.sql
      .prepare('INSERT INTO child_sessions (session_id, parent_session, tool_use_id, kind, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(child.sessionId, child.parentId, child.toolUseId, child.kind, Date.now())
  }

  /** Every child chat's id, to keep them out of the sidebar. */
  childIds(): Set<string> {
    const rows = this.db.sql.prepare('SELECT session_id FROM child_sessions').all() as { session_id: string }[]
    return new Set(rows.map((r) => r.session_id))
  }

  /** A chat's children by the tool call that started each one. */
  children(parentId: string): Record<string, string> {
    const rows = this.db.sql.prepare('SELECT session_id, tool_use_id FROM child_sessions WHERE parent_session = ?').all(parentId) as {
      session_id: string
      tool_use_id: string
    }[]
    return Object.fromEntries(rows.map((r) => [r.tool_use_id, r.session_id]))
  }

  addFork(fork: { sessionId: string; sourceId: string; cwd: string; worktree?: string; note?: string }): void {
    this.db.sql
      .prepare('INSERT INTO forks (session_id, source_id, cwd, worktree, note, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(fork.sessionId, fork.sourceId, fork.cwd, fork.worktree ?? null, fork.note ?? null, Date.now())
  }

  /** A fork's folder, and the new worktree it starts in, while it hasn't. */
  forkStart(sessionId: string): { cwd: string; worktree: string } | undefined {
    return this.db.sql.prepare('SELECT cwd, worktree FROM forks WHERE session_id = ? AND worktree IS NOT NULL').get(sessionId) as
      | { cwd: string; worktree: string }
      | undefined
  }

  /** The fork has started in its worktree, so later starts resume wherever it is. */
  forkStarted(sessionId: string): void {
    this.db.sql.prepare('UPDATE forks SET worktree = NULL WHERE session_id = ?').run(sessionId)
  }

  /** What a fork that moved is told about it, until Claude has been. */
  forkNote(sessionId: string): string | undefined {
    const row = this.db.sql.prepare('SELECT note FROM forks WHERE session_id = ?').get(sessionId) as { note: string | null } | undefined
    return row?.note ?? undefined
  }

  forkNoteSeen(sessionId: string): void {
    this.db.sql.prepare('UPDATE forks SET note = NULL WHERE session_id = ?').run(sessionId)
  }

  removeFork(sessionId: string): void {
    this.db.sql.prepare('DELETE FROM forks WHERE session_id = ?').run(sessionId)
  }

  addReview(review: { sessionId: string; sourceId: string }): void {
    this.db.sql.prepare('INSERT INTO review_sessions (session_id, source_id, created_at) VALUES (?, ?, ?)').run(review.sessionId, review.sourceId, Date.now())
  }

  reviewIds(): Set<string> {
    const rows = this.db.sql.prepare('SELECT session_id FROM review_sessions').all() as { session_id: string }[]
    return new Set(rows.map((r) => r.session_id))
  }

  isReview(sessionId: string): boolean {
    return !!this.db.sql.prepare('SELECT 1 FROM review_sessions WHERE session_id = ?').get(sessionId)
  }

  /** The latest review started from a chat that isn't archived, if any. */
  reviewOf(sourceId: string): string | undefined {
    const row = this.db.sql
      .prepare(
        'SELECT session_id FROM review_sessions WHERE source_id = ? AND session_id NOT IN (SELECT session_id FROM archived_sessions) ORDER BY created_at DESC LIMIT 1',
      )
      .get(sourceId) as { session_id: string } | undefined
    return row?.session_id
  }

  /** A hash of the card context Claude was last given, so the same isn't given again after a restart. */
  contextHash(sessionId: string): string | undefined {
    const row = this.db.sql.prepare('SELECT hash FROM session_context WHERE session_id = ?').get(sessionId) as { hash: string } | undefined
    return row?.hash
  }

  setContextHash(sessionId: string, hash: string | null): void {
    if (hash === null) this.db.sql.prepare('DELETE FROM session_context WHERE session_id = ?').run(sessionId)
    else
      this.db.sql
        .prepare('INSERT INTO session_context (session_id, hash) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET hash = excluded.hash')
        .run(sessionId, hash)
  }
}
