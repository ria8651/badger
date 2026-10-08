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

/** Project data that spans repos and users: cards and which chats belong to them. */
export class Store {
  private db: DatabaseSync

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

  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN')
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
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

  createCard(input: { title: string; description?: string; status?: CardStatus }): Card {
    const title = requireTitle(input.title)
    const status = requireStatus(input.status ?? 'backlog')
    const now = Date.now()
    const { lastInsertRowid } = this.db
      .prepare('INSERT INTO cards (title, description, status, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(title, input.description ?? '', status, this.endOf(status), now, now)
    return this.card(Number(lastInsertRowid))!
  }

  updateCard(id: number, patch: CardPatch): Card | undefined {
    const current = this.card(id)
    if (!current) return undefined
    const next = { ...current }
    if (patch.title !== undefined) next.title = requireTitle(patch.title)
    if (patch.description !== undefined) next.description = String(patch.description)
    if (patch.status !== undefined) next.status = requireStatus(patch.status)
    if (patch.position !== undefined) next.position = Number(patch.position)
    // Moving columns without a position lands at the bottom of the new one.
    else if (next.status !== current.status) next.position = this.endOf(next.status)
    this.transaction(() => {
      this.db
        .prepare('UPDATE cards SET title = ?, description = ?, status = ?, position = ?, updated_at = ? WHERE id = ?')
        .run(next.title, next.description, next.status, next.position, Date.now(), id)
      // Finishing a card puts its chats away; reopening it brings them back.
      if (next.status === 'done' && current.status !== 'done') for (const s of current.sessionIds) this.setArchived(s, true)
      if (next.status !== 'done' && current.status === 'done') for (const s of current.sessionIds) this.setArchived(s, false)
    })
    return this.card(id)
  }

  deleteCard(id: number): boolean {
    return this.db.prepare('DELETE FROM cards WHERE id = ?').run(id).changes > 0
  }

  /** Attaches a chat to a card, moving it off any card it was on. */
  linkSession(cardId: number, sessionId: string): void {
    this.db
      .prepare(
        'INSERT INTO card_sessions (session_id, card_id, created_at) VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET card_id = excluded.card_id',
      )
      .run(sessionId, cardId, Date.now())
  }

  unlinkSession(cardId: number, sessionId: string): boolean {
    return this.db.prepare('DELETE FROM card_sessions WHERE card_id = ? AND session_id = ?').run(cardId, sessionId).changes > 0
  }

  archivedIds(): Set<string> {
    const rows = this.db.prepare('SELECT session_id FROM archived_sessions').all() as { session_id: string }[]
    return new Set(rows.map((r) => r.session_id))
  }

  /** Returns whether anything changed. */
  setArchived(sessionId: string, archived: boolean): boolean {
    const result = archived
      ? this.db.prepare('INSERT INTO archived_sessions (session_id, archived_at) VALUES (?, ?) ON CONFLICT DO NOTHING').run(sessionId, Date.now())
      : this.db.prepare('DELETE FROM archived_sessions WHERE session_id = ?').run(sessionId)
    if (result.changes > 0) this.onArchived()
    return result.changes > 0
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
