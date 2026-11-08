import { NO_ATTACHMENTS, hasAttachments, type Draft, type StartAt } from '../shared/protocol.ts'
import type { Actor, Database } from './db.ts'

const UNTYPED_DRAFT_MS = 7 * 24 * 60 * 60 * 1000

type StartRow = { machine: string; cwd: string | null; worktree: number }
const startAt = (r: StartRow): StartAt => ({ machine: r.machine, ...(r.cwd ? { cwd: r.cwd } : {}), ...(r.worktree ? { worktree: true } : {}) })

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
  ) {
    this.dropUntypedDrafts()
  }

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
    const row = this.db.sql.prepare('SELECT text, attachments, machine, cwd, worktree FROM session_drafts WHERE session_id = ?').get(sessionId) as
      | { text: string; attachments: string | null; machine: string | null; cwd: string | null; worktree: number }
      | undefined
    return {
      text: row?.text ?? '',
      attachments: row?.attachments ? JSON.parse(row.attachments) : NO_ATTACHMENTS,
      ...(row?.machine ? { start: startAt(row as StartRow) } : {}),
    }
  }

  /** Replaces a chat's draft. One with nothing in it is deleted rather than stored. */
  setDraft(sessionId: string, draft: Draft): void {
    const { text, attachments, start } = draft
    const attached = hasAttachments(attachments)
    if (!text && !attached && !start) this.db.sql.prepare('DELETE FROM session_drafts WHERE session_id = ?').run(sessionId)
    else
      this.db.sql
        .prepare(
          `INSERT INTO session_drafts (session_id, text, attachments, machine, cwd, worktree, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(session_id) DO UPDATE SET text = excluded.text, attachments = excluded.attachments, machine = excluded.machine,
             cwd = excluded.cwd, worktree = excluded.worktree, updated_at = excluded.updated_at`,
        )
        .run(sessionId, text, attached ? JSON.stringify(attachments) : null, start?.machine ?? null, start?.cwd ?? null, start?.worktree ? 1 : 0, Date.now())
  }

  /**
   * Every draft with something typed or attached: how it starts, what's attached, when it last changed, and where a
   * chat that hasn't started will run. Attachments are counted, not read, since images can be big; one that can't be
   * read counts as none, rather than keeping every chat from being listed.
   */
  typedDrafts(): { sessionId: string; text: string; pastes: number; images: number; start?: StartAt; updatedAt: number }[] {
    const count = (path: string) => `CASE WHEN json_valid(attachments) THEN coalesce(json_array_length(attachments, '${path}'), 0) ELSE 0 END`
    const rows = this.db.sql
      .prepare(
        `SELECT session_id, substr(text, 1, 500) AS text, machine, cwd, worktree, updated_at, ${count('$.pastes')} AS pastes, ${count('$.images')} AS images
         FROM session_drafts WHERE text != '' OR attachments IS NOT NULL`,
      )
      .all() as ({ session_id: string; text: string; pastes: number; images: number; updated_at: number } & StartRow)[]
    return rows.map((r) => ({
      sessionId: r.session_id,
      text: r.text,
      pastes: r.pastes,
      images: r.images,
      ...(r.machine ? { start: startAt(r) } : {}),
      updatedAt: r.updated_at,
    }))
  }

  /** Drafts with nothing typed, only where a chat that never started was to run, once they're a week old. */
  private dropUntypedDrafts(): void {
    this.db.sql.prepare("DELETE FROM session_drafts WHERE text = '' AND attachments IS NULL AND updated_at < ?").run(Date.now() - UNTYPED_DRAFT_MS)
  }

  unreadIds(): Set<string> {
    const rows = this.db.sql.prepare('SELECT session_id FROM unread_sessions').all() as { session_id: string }[]
    return new Set(rows.map((r) => r.session_id))
  }

  /** When it last became unread, if it is. */
  unreadSince(sessionId: string): number | undefined {
    const row = this.db.sql.prepare('SELECT at FROM unread_sessions WHERE session_id = ?').get(sessionId) as { at: number } | undefined
    return row?.at
  }

  /** Returns whether anything changed. */
  setUnread(sessionId: string, unread: boolean): boolean {
    const result = unread
      ? this.db.sql.prepare('INSERT INTO unread_sessions (session_id, at) VALUES (?, ?) ON CONFLICT DO NOTHING').run(sessionId, Date.now())
      : this.db.sql.prepare('DELETE FROM unread_sessions WHERE session_id = ?').run(sessionId)
    return result.changes > 0
  }

  /** Every chat's recap of where its last turn left it, by id. */
  recaps(): Map<string, string> {
    const rows = this.db.sql.prepare('SELECT session_id, text FROM session_recaps WHERE stale = 0 ORDER BY at').all() as { session_id: string; text: string }[]
    return new Map(rows.map((r) => [r.session_id, r.text]))
  }

  /** How many recaps of a chat were made since then, stale ones too. */
  recapsSince(sessionId: string, at: number): number {
    return (this.db.sql.prepare('SELECT count(*) AS n FROM session_recaps WHERE session_id = ? AND at >= ?').get(sessionId, at) as { n: number }).n
  }

  addRecap(sessionId: string, text: string): void {
    this.db.sql.prepare('INSERT INTO session_recaps (session_id, text, at) VALUES (?, ?, ?)').run(sessionId, text, Date.now())
  }

  /** Another turn has ended, so the chat's recap no longer says where it is. It's kept. Returns whether there was one. */
  staleRecap(sessionId: string): boolean {
    return this.db.sql.prepare('UPDATE session_recaps SET stale = 1 WHERE session_id = ? AND stale = 0').run(sessionId).changes > 0
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

  /** Every child chat: its parent, the call that started it there, and what it's for, e.g. merge. */
  allChildren(): { sessionId: string; parentId: string; toolUseId: string; kind: string }[] {
    const rows = this.db.sql.prepare('SELECT session_id, parent_session, tool_use_id, kind FROM child_sessions').all() as {
      session_id: string
      parent_session: string
      tool_use_id: string
      kind: string
    }[]
    return rows.map((r) => ({ sessionId: r.session_id, parentId: r.parent_session, toolUseId: r.tool_use_id, kind: r.kind }))
  }

  /** A chat's children by the tool call that started each one. */
  children(parentId: string): Record<string, string> {
    const rows = this.db.sql.prepare('SELECT session_id, tool_use_id FROM child_sessions WHERE parent_session = ?').all(parentId) as {
      session_id: string
      tool_use_id: string
    }[]
    return Object.fromEntries(rows.map((r) => [r.tool_use_id, r.session_id]))
  }

  /** For a child chat: the chat that started it, the call there that did, and what it's for. */
  startedBy(sessionId: string): { parentId: string; toolUseId: string; kind: string } | undefined {
    const row = this.db.sql.prepare('SELECT parent_session, tool_use_id, kind FROM child_sessions WHERE session_id = ?').get(sessionId) as
      | { parent_session: string; tool_use_id: string; kind: string }
      | undefined
    return row && { parentId: row.parent_session, toolUseId: row.tool_use_id, kind: row.kind }
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

  /** `sourceId` is the chat it was started from, or empty if there was none with anything in it. */
  removeReview(sessionId: string): void {
    this.db.sql.prepare('DELETE FROM review_sessions WHERE session_id = ?').run(sessionId)
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

  addSideChat(sessionId: string, parentId: string): void {
    this.db.sql.prepare('INSERT INTO side_chats (session_id, parent_session, created_at) VALUES (?, ?, ?)').run(sessionId, parentId, Date.now())
  }

  removeSideChat(sessionId: string): void {
    this.db.sql.prepare('DELETE FROM side_chats WHERE session_id = ?').run(sessionId)
  }

  /** Every side chat, by id: the chat it's under, and when it was made. */
  sideChats(): Map<string, { parent: string; at: number }> {
    const rows = this.db.sql.prepare('SELECT session_id, parent_session, created_at FROM side_chats').all() as {
      session_id: string
      parent_session: string
      created_at: number
    }[]
    return new Map(rows.map((r) => [r.session_id, { parent: r.parent_session, at: r.created_at }]))
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
