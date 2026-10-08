import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { CARD_STATUSES, type Card, type CardStatus } from '../shared/protocol.ts'

/** Each entry runs once, in order; PRAGMA user_version counts how many have run. Never edit one that has shipped. */
const MIGRATIONS = [
  `CREATE TABLE cards (
     id INTEGER PRIMARY KEY,
     title TEXT NOT NULL,
     description TEXT NOT NULL DEFAULT '',
     status TEXT NOT NULL,
     position REAL NOT NULL,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );
   -- A chat belongs to at most one card; cards span repos, so nothing here is tied to a cwd.
   CREATE TABLE card_sessions (
     session_id TEXT PRIMARY KEY,
     card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
     created_at INTEGER NOT NULL
   );
   CREATE INDEX card_sessions_card ON card_sessions(card_id);`,
  // What each chat was last told about its card, so unchanged context isn't injected again after a restart.
  `CREATE TABLE session_context (
     session_id TEXT PRIMARY KEY,
     hash TEXT NOT NULL
   );`,
  // An unreleased migration (turn_results) ran here on some local databases; kept as a no-op so their versions still line up.
  `SELECT 1;`,
  // Archived chats are hidden from the sidebar. Their transcripts are never touched.
  `DROP TABLE IF EXISTS turn_results;
   CREATE TABLE archived_sessions (
     session_id TEXT PRIMARY KEY,
     archived_at INTEGER NOT NULL
   );`,
  // Text typed into a chat's composer but not sent yet.
  `CREATE TABLE session_drafts (
     session_id TEXT PRIMARY KEY,
     text TEXT NOT NULL,
     updated_at INTEGER NOT NULL
   );`,
  // Every change to board data, append-only. before/after hold the changed fields as JSON; a delete keeps the whole card so it can be restored.
  `CREATE TABLE audit_log (
     id INTEGER PRIMARY KEY,
     at INTEGER NOT NULL,
     actor TEXT NOT NULL,
     actor_session TEXT,
     entity TEXT NOT NULL,
     entity_id TEXT NOT NULL,
     action TEXT NOT NULL,
     before TEXT,
     after TEXT
   );
   CREATE INDEX audit_log_entity ON audit_log(entity, entity_id);`,
]

interface CardRow {
  id: number
  title: string
  description: string
  status: CardStatus
  position: number
  created_at: number
  updated_at: number
}

export type CardPatch = Partial<Pick<Card, 'title' | 'description' | 'status' | 'position'>>

/** Who made a change. There are no users yet, so for now it's where the change came from. */
export type Actor = { source: 'ui' } | { source: 'claude'; sessionId: string }

type AuditEntity = 'card' | 'card_session' | 'archived_session'
type AuditAction = 'create' | 'update' | 'delete' | 'link' | 'unlink' | 'archive' | 'unarchive'

/** Project data that spans repos and users: cards and which chats belong to them. */
export class Store {
  private db: DatabaseSync
  private inTransaction = false

  /** @param onArchived called whenever a chat is archived or unarchived, including by a card's status changing. */
  constructor(
    dir: string,
    private onArchived: () => void = () => {},
  ) {
    mkdirSync(dir, { recursive: true })
    this.db = new DatabaseSync(join(dir, 'badger.db'))
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON')
    this.migrate()
  }

  private migrate(): void {
    const { user_version } = this.db.prepare('PRAGMA user_version').get() as { user_version: number }
    for (let v = user_version; v < MIGRATIONS.length; v++) {
      this.transaction(() => {
        this.db.exec(MIGRATIONS[v])
        this.db.exec(`PRAGMA user_version = ${v + 1}`)
      })
    }
  }

  /** Joins the enclosing transaction if there is one, so writes that call each other stay atomic. */
  private transaction<T>(fn: () => T): T {
    if (this.inTransaction) return fn()
    this.db.exec('BEGIN')
    this.inTransaction = true
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    } finally {
      this.inTransaction = false
    }
  }

  /** Call inside the same transaction as the change it records. */
  private audit(actor: Actor, entity: AuditEntity, entityId: string | number, action: AuditAction, before: object | null, after: object | null): void {
    this.db
      .prepare('INSERT INTO audit_log (at, actor, actor_session, entity, entity_id, action, before, after) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(
        Date.now(),
        actor.source,
        actor.source === 'claude' ? actor.sessionId : null,
        entity,
        String(entityId),
        action,
        before && JSON.stringify(before),
        after && JSON.stringify(after),
      )
  }

  cards(): Card[] {
    const rows = this.db.prepare('SELECT * FROM cards ORDER BY position').all() as unknown as CardRow[]
    const links = this.db.prepare('SELECT card_id, session_id FROM card_sessions ORDER BY created_at').all() as {
      card_id: number
      session_id: string
    }[]
    const sessions = new Map<number, string[]>()
    for (const l of links) sessions.set(l.card_id, [...(sessions.get(l.card_id) ?? []), l.session_id])
    return rows.map((r) => toCard(r, sessions.get(r.id) ?? []))
  }

  card(id: number): Card | undefined {
    const row = this.db.prepare('SELECT * FROM cards WHERE id = ?').get(id) as CardRow | undefined
    if (!row) return undefined
    const links = this.db.prepare('SELECT session_id FROM card_sessions WHERE card_id = ? ORDER BY created_at').all(id) as {
      session_id: string
    }[]
    return toCard(
      row,
      links.map((l) => l.session_id),
    )
  }

  createCard(input: { title: string; description?: string; status?: CardStatus }, actor: Actor): Card {
    const title = requireTitle(input.title)
    const status = requireStatus(input.status ?? 'backlog')
    const now = Date.now()
    return this.transaction(() => {
      const { lastInsertRowid } = this.db
        .prepare('INSERT INTO cards (title, description, status, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(title, input.description ?? '', status, this.endOf(status), now, now)
      const card = this.card(Number(lastInsertRowid))!
      this.audit(actor, 'card', card.id, 'create', null, editable(card))
      return card
    })
  }

  updateCard(id: number, patch: CardPatch, actor: Actor): Card | undefined {
    const current = this.card(id)
    if (!current) return undefined
    const next = { ...current }
    if (patch.title !== undefined) next.title = requireTitle(patch.title)
    if (patch.description !== undefined) next.description = String(patch.description)
    if (patch.status !== undefined) next.status = requireStatus(patch.status)
    if (patch.position !== undefined) next.position = Number(patch.position)
    // Moving columns without a position lands at the bottom of the new one.
    else if (next.status !== current.status) next.position = this.endOf(next.status)
    const before: CardPatch = {}
    const after: CardPatch = {}
    for (const key of ['title', 'description', 'status', 'position'] as const) {
      if (next[key] === current[key]) continue
      Object.assign(before, { [key]: current[key] })
      Object.assign(after, { [key]: next[key] })
    }
    // Repeating an update changes nothing, so it isn't written or logged.
    if (!Object.keys(after).length) return current
    this.transaction(() => {
      this.db
        .prepare('UPDATE cards SET title = ?, description = ?, status = ?, position = ?, updated_at = ? WHERE id = ?')
        .run(next.title, next.description, next.status, next.position, Date.now(), id)
      this.audit(actor, 'card', id, 'update', before, after)
      // Finishing a card puts its chats away; reopening it brings them back.
      if (next.status === 'done' && current.status !== 'done') for (const s of current.sessionIds) this.setArchived(s, true, actor)
      if (next.status !== 'done' && current.status === 'done') for (const s of current.sessionIds) this.setArchived(s, false, actor)
    })
    return this.card(id)
  }

  /** The log keeps the whole card, chats included, so a deleted card can be restored. */
  deleteCard(id: number, actor: Actor): boolean {
    const card = this.card(id)
    if (!card) return false
    this.transaction(() => {
      this.db.prepare('DELETE FROM cards WHERE id = ?').run(id)
      this.audit(actor, 'card', id, 'delete', card, null)
    })
    return true
  }

  /** Attaches a chat to a card, moving it off any card it was on. */
  linkSession(cardId: number, sessionId: string, actor: Actor): void {
    this.transaction(() => {
      const current = this.db.prepare('SELECT card_id FROM card_sessions WHERE session_id = ?').get(sessionId) as { card_id: number } | undefined
      if (current?.card_id === cardId) return
      this.db
        .prepare(
          'INSERT INTO card_sessions (session_id, card_id, created_at) VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET card_id = excluded.card_id',
        )
        .run(sessionId, cardId, Date.now())
      this.audit(actor, 'card_session', sessionId, 'link', current ? { cardId: current.card_id } : null, { cardId })
    })
  }

  unlinkSession(cardId: number, sessionId: string, actor: Actor): boolean {
    return this.transaction(() => {
      const removed = this.db.prepare('DELETE FROM card_sessions WHERE card_id = ? AND session_id = ?').run(cardId, sessionId).changes > 0
      if (removed) this.audit(actor, 'card_session', sessionId, 'unlink', { cardId }, null)
      return removed
    })
  }

  archivedIds(): Set<string> {
    const rows = this.db.prepare('SELECT session_id FROM archived_sessions').all() as { session_id: string }[]
    return new Set(rows.map((r) => r.session_id))
  }

  /** Returns whether anything changed. */
  setArchived(sessionId: string, archived: boolean, actor: Actor): boolean {
    const changed = this.transaction(() => {
      const result = archived
        ? this.db.prepare('INSERT INTO archived_sessions (session_id, archived_at) VALUES (?, ?) ON CONFLICT DO NOTHING').run(sessionId, Date.now())
        : this.db.prepare('DELETE FROM archived_sessions WHERE session_id = ?').run(sessionId)
      if (result.changes > 0) this.audit(actor, 'archived_session', sessionId, archived ? 'archive' : 'unarchive', null, null)
      return result.changes > 0
    })
    if (changed) this.onArchived()
    return changed
  }

  draft(sessionId: string): string {
    const row = this.db.prepare('SELECT text FROM session_drafts WHERE session_id = ?').get(sessionId) as { text: string } | undefined
    return row?.text ?? ''
  }

  /** An empty draft is deleted rather than stored. */
  setDraft(sessionId: string, text: string): void {
    if (!text) this.db.prepare('DELETE FROM session_drafts WHERE session_id = ?').run(sessionId)
    else
      this.db
        .prepare(
          'INSERT INTO session_drafts (session_id, text, updated_at) VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at',
        )
        .run(sessionId, text, Date.now())
  }

  contextHash(sessionId: string): string | undefined {
    const row = this.db.prepare('SELECT hash FROM session_context WHERE session_id = ?').get(sessionId) as { hash: string } | undefined
    return row?.hash
  }

  setContextHash(sessionId: string, hash: string | null): void {
    if (hash === null) this.db.prepare('DELETE FROM session_context WHERE session_id = ?').run(sessionId)
    else
      this.db
        .prepare('INSERT INTO session_context (session_id, hash) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET hash = excluded.hash')
        .run(sessionId, hash)
  }

  private endOf(status: CardStatus): number {
    const { max } = this.db.prepare('SELECT MAX(position) AS max FROM cards WHERE status = ?').get(status) as { max: number | null }
    return (max ?? 0) + 1
  }
}

function editable(c: Card): CardPatch {
  return { title: c.title, description: c.description, status: c.status, position: c.position }
}

function toCard(r: CardRow, sessionIds: string[]): Card {
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    status: r.status,
    position: r.position,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    sessionIds,
  }
}

function requireTitle(title: unknown): string {
  const t = typeof title === 'string' ? title.trim() : ''
  if (!t) throw new BadRequest('Title is required')
  return t
}

function requireStatus(status: unknown): CardStatus {
  if (!CARD_STATUSES.includes(status as CardStatus)) throw new BadRequest(`Unknown status: ${status}`)
  return status as CardStatus
}

export class BadRequest extends Error {}
