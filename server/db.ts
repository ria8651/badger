import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { descendants } from '../shared/cardTree.ts'
import { CARD_STATUSES, type Card, type CardStatus, type DraftAttachments } from '../shared/protocol.ts'

/**
 * Transcript lines holding images, and the uuid the SDK's reader gives each one's message: a message sent while
 * Claude was busy is written as an attachment under a uuid of its own, and read back under its `source_uuid`.
 * Queries must use these exactly, to use the index on them.
 */
export const IMAGE_LINE = `instr(entry, '"type":"base64"') > 0`
export const IMAGE_LINE_UUID = `(CASE WHEN json_valid(entry) THEN coalesce(json_extract(entry, '$.attachment.source_uuid'), json_extract(entry, '$.uuid')) END)`

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
  // Chats another chat started and waits on, like a subagent: hidden from the sidebar and shown inside the parent's tool call.
  `CREATE TABLE child_sessions (
     session_id TEXT PRIMARY KEY,
     parent_session TEXT NOT NULL,
     tool_use_id TEXT NOT NULL,
     kind TEXT NOT NULL,
     created_at INTEGER NOT NULL
   );
   CREATE INDEX child_sessions_parent ON child_sessions(parent_session);`,
  // Pastes and images waiting in a chat's composer, as JSON DraftAttachments.
  `ALTER TABLE session_drafts ADD COLUMN attachments TEXT;`,
  // Chats whose turn ended since anyone last looked at them. One user for now, so one set.
  `CREATE TABLE unread_sessions (
     session_id TEXT PRIMARY KEY,
     at INTEGER NOT NULL
   );`,
  // Cards hold cards: each card is a board of its own. Null is the top-level board.
  `ALTER TABLE cards ADD COLUMN parent_id INTEGER REFERENCES cards(id);
   CREATE INDEX cards_parent ON cards(parent_id);`,
  // Deleting a card only marks it, so it stays in the table and is migrated like any other row, ready for a restore feature later.
  // The cards inside it aren't marked; they're hidden because it is (see VISIBLE).
  `ALTER TABLE cards ADD COLUMN deleted_at INTEGER;`,
  // Folders added in the file browser, and ones taken off the new-chat list. Others are found from where chats ran.
  `CREATE TABLE folders (
     path TEXT PRIMARY KEY,
     added_at INTEGER NOT NULL,
     hidden_at INTEGER
   );`,
  // Machines chats and terminals run on. The hub's own is 'local'; others connect with a token, kept hashed.
  // named is whether someone named it; until then it takes its host's name. info is what it said about itself when
  // it last connected, as JSON. A removed machine is only marked, so its id is never given to another machine and its
  // chats can't come back to life there.
  `CREATE TABLE machines (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     named INTEGER NOT NULL DEFAULT 0,
     token_hash TEXT UNIQUE,
     created_at INTEGER NOT NULL,
     last_seen INTEGER,
     info TEXT,
     removed_at INTEGER
   );
   -- The machine each chat runs on. A chat stays on the machine it started on.
   CREATE TABLE chat_machines (
     session_id TEXT PRIMARY KEY,
     machine TEXT NOT NULL,
     created_at INTEGER NOT NULL
   );
   CREATE INDEX chat_machines_machine ON chat_machines(machine);
   -- Claude Code's transcripts, copied line by line from the machine each chat runs on, so chats can be read while it's away.
   -- subpath is '' for a chat's own transcript, or e.g. 'subagents/agent-<id>'.
   CREATE TABLE transcript_files (
     session_id TEXT NOT NULL,
     subpath TEXT NOT NULL,
     project TEXT NOT NULL,
     lines INTEGER NOT NULL,
     bytes INTEGER NOT NULL,
     mtime INTEGER NOT NULL,
     meta TEXT,
     PRIMARY KEY (session_id, subpath)
   );
   CREATE TABLE transcript_lines (
     session_id TEXT NOT NULL,
     subpath TEXT NOT NULL,
     n INTEGER NOT NULL,
     entry TEXT NOT NULL,
     PRIMARY KEY (session_id, subpath, n)
   ) WITHOUT ROWID;
   -- The SDK's running summary of each chat's transcript (foldSessionSummary), so chats can be listed without reading them.
   CREATE TABLE transcript_summaries (
     session_id TEXT PRIMARY KEY,
     mtime INTEGER NOT NULL,
     data TEXT NOT NULL
   );
   -- Before machines, every chat ran on the hub's. Which were Badger's wasn't recorded, so they're brought in once at
   -- startup from Claude Code's transcripts (importOlderChats in index.ts); this row says that's still to do. The ones
   -- on cards and their children, however deep, are certainly the hub's.
   CREATE TABLE pending_import (id INTEGER PRIMARY KEY CHECK (id = 1));
   INSERT INTO pending_import (id) VALUES (1);
   WITH RECURSIVE tree(session_id) AS (
     SELECT session_id FROM card_sessions
     UNION SELECT c.session_id FROM child_sessions c JOIN tree ON c.parent_session = tree.session_id
   )
   INSERT OR IGNORE INTO chat_machines (session_id, machine, created_at) SELECT session_id, 'local', 0 FROM tree;
   -- Folders are on a machine too.
   CREATE TABLE machine_folders (
     machine TEXT NOT NULL,
     path TEXT NOT NULL,
     added_at INTEGER NOT NULL,
     hidden_at INTEGER,
     PRIMARY KEY (machine, path)
   );
   INSERT INTO machine_folders (machine, path, added_at, hidden_at) SELECT 'local', path, added_at, hidden_at FROM folders;
   DROP TABLE folders;`,
  // Chats forked from another. Until a fork first runs: the new worktree it goes into, if any, and what Claude is told about moving.
  `CREATE TABLE forks (
     session_id TEXT PRIMARY KEY,
     source_id TEXT NOT NULL,
     cwd TEXT NOT NULL,
     worktree TEXT,
     note TEXT,
     created_at INTEGER NOT NULL
   );`,
  // So a chat's images can be served one at a time, without reading the chat.
  `CREATE INDEX transcript_lines_images ON transcript_lines (session_id, ${IMAGE_LINE_UUID}) WHERE ${IMAGE_LINE};`,
]

/**
 * Cards that aren't deleted and aren't inside one that is. Only the card someone deleted is marked, so restoring
 * one later is clearing that mark, and a card deleted on its own before its project would stay deleted.
 */
const VISIBLE = `WITH RECURSIVE hidden(id) AS (
    SELECT id FROM cards WHERE deleted_at IS NOT NULL
    UNION SELECT cards.id FROM cards JOIN hidden ON cards.parent_id = hidden.id
  )
  SELECT * FROM cards WHERE id NOT IN (SELECT id FROM hidden)`

interface CardRow {
  id: number
  parent_id: number | null
  deleted_at: number | null
  title: string
  description: string
  status: CardStatus
  position: number
  created_at: number
  updated_at: number
}

export type CardPatch = Partial<Pick<Card, 'title' | 'description' | 'status' | 'position' | 'parentId'>>

/** Who made a change. There are no users yet, so for now it's where the change came from. */
/** A chat's unsent composer contents. */
export type Draft = { text: string; attachments: DraftAttachments }

export type Actor = { source: 'ui' } | { source: 'claude'; sessionId: string }

type AuditEntity = 'card' | 'card_session' | 'archived_session'
type AuditAction = 'create' | 'update' | 'delete' | 'link' | 'unlink' | 'archive' | 'unarchive'

/** Project data that spans repos and users: cards and which chats belong to them. */
export class Store {
  /** Shared with the other tables' owners: machines and transcripts. */
  readonly db: DatabaseSync
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
  transaction<T>(fn: () => T): T {
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

  /** Every card that isn't deleted. */
  cards(): Card[] {
    const rows = this.db.prepare(`${VISIBLE} ORDER BY position`).all() as unknown as CardRow[]
    const links = this.db.prepare('SELECT card_id, session_id FROM card_sessions ORDER BY created_at').all() as {
      card_id: number
      session_id: string
    }[]
    const sessions = new Map<number, string[]>()
    for (const l of links) sessions.set(l.card_id, [...(sessions.get(l.card_id) ?? []), l.session_id])
    const moved = this.statusChanges()
    return rows.map((r) => toCard(r, sessions.get(r.id) ?? [], moved.get(r.id)))
  }

  card(id: number): Card | undefined {
    const row = this.db.prepare(`${VISIBLE} AND id = ?`).get(id) as CardRow | undefined
    if (!row) return undefined
    const links = this.db.prepare('SELECT session_id FROM card_sessions WHERE card_id = ? ORDER BY created_at').all(id) as {
      session_id: string
    }[]
    return toCard(
      row,
      links.map((l) => l.session_id),
      this.statusChanges(id).get(id),
    )
  }

  /** When each card (or just `id`) last changed status, by the audit log. Creating one counts. */
  private statusChanges(id?: number): Map<number, number> {
    const rows = this.db
      .prepare(
        `SELECT entity_id, MAX(at) AS at FROM audit_log
         WHERE entity = 'card' AND action IN ('create', 'update') AND json_extract(after, '$.status') IS NOT NULL ${id === undefined ? '' : 'AND entity_id = ?'}
         GROUP BY entity_id`,
      )
      .all(...(id === undefined ? [] : [String(id)])) as { entity_id: string; at: number }[]
    return new Map(rows.map((r) => [Number(r.entity_id), r.at]))
  }

  createCard(input: { title: string; description?: string; status?: CardStatus; parentId?: number | null }, actor: Actor): Card {
    const title = requireTitle(input.title)
    const status = requireStatus(input.status ?? 'backlog')
    const parentId = this.requireParent(input.parentId ?? null)
    const now = Date.now()
    return this.transaction(() => {
      const { lastInsertRowid } = this.db
        .prepare('INSERT INTO cards (title, description, status, position, parent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(title, input.description ?? '', status, this.endOf(status), parentId, now, now)
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
    if (patch.parentId !== undefined) next.parentId = this.requireParent(patch.parentId, id)
    if (patch.position !== undefined) next.position = Number(patch.position)
    // Moving columns without a position lands at the bottom of the new one.
    else if (next.status !== current.status) next.position = this.endOf(next.status)
    const before: CardPatch = {}
    const after: CardPatch = {}
    for (const key of ['title', 'description', 'status', 'position', 'parentId'] as const) {
      if (next[key] === current[key]) continue
      Object.assign(before, { [key]: current[key] })
      Object.assign(after, { [key]: next[key] })
    }
    // Repeating an update changes nothing, so it isn't written or logged.
    if (!Object.keys(after).length) return current
    this.transaction(() => {
      this.db
        .prepare('UPDATE cards SET title = ?, description = ?, status = ?, position = ?, parent_id = ?, updated_at = ? WHERE id = ?')
        .run(next.title, next.description, next.status, next.position, next.parentId, Date.now(), id)
      this.audit(actor, 'card', id, 'update', before, after)
      // Finishing a card puts its chats away; reopening it brings them back.
      if (next.status === 'done' && current.status !== 'done') for (const s of current.sessionIds) this.setArchived(s, true, actor)
      if (next.status !== 'done' && current.status === 'done') for (const s of current.sessionIds) this.setArchived(s, false, actor)
    })
    return this.card(id)
  }

  /** Marks just this card deleted; the cards inside it are hidden with it. Chats stay linked but are no longer on a card. */
  deleteCard(id: number, actor: Actor): boolean {
    if (!this.card(id)) return false
    this.transaction(() => {
      this.db.prepare('UPDATE cards SET deleted_at = ? WHERE id = ?').run(Date.now(), id)
      this.audit(actor, 'card', id, 'delete', null, null)
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

  draft(sessionId: string): Draft {
    const row = this.db.prepare('SELECT text, attachments FROM session_drafts WHERE session_id = ?').get(sessionId) as
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
    if (!text && !attached) this.db.prepare('DELETE FROM session_drafts WHERE session_id = ?').run(sessionId)
    else
      this.db
        .prepare(
          'INSERT INTO session_drafts (session_id, text, attachments, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET text = excluded.text, attachments = excluded.attachments, updated_at = excluded.updated_at',
        )
        .run(sessionId, text, attached ? JSON.stringify(attachments) : null, Date.now())
  }

  unreadIds(): Set<string> {
    const rows = this.db.prepare('SELECT session_id FROM unread_sessions').all() as { session_id: string }[]
    return new Set(rows.map((r) => r.session_id))
  }

  /** Returns whether anything changed. */
  setUnread(sessionId: string, unread: boolean): boolean {
    const result = unread
      ? this.db.prepare('INSERT INTO unread_sessions (session_id, at) VALUES (?, ?) ON CONFLICT DO NOTHING').run(sessionId, Date.now())
      : this.db.prepare('DELETE FROM unread_sessions WHERE session_id = ?').run(sessionId)
    return result.changes > 0
  }

  /** The chat that started this one, if it's a child. */
  parentOf(sessionId: string): string | undefined {
    const row = this.db.prepare('SELECT parent_session FROM child_sessions WHERE session_id = ?').get(sessionId) as { parent_session: string } | undefined
    return row?.parent_session
  }

  addChild(child: { sessionId: string; parentId: string; toolUseId: string; kind: string }): void {
    this.db
      .prepare('INSERT INTO child_sessions (session_id, parent_session, tool_use_id, kind, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(child.sessionId, child.parentId, child.toolUseId, child.kind, Date.now())
  }

  /** Every child chat's id, to keep them out of the sidebar. */
  childIds(): Set<string> {
    const rows = this.db.prepare('SELECT session_id FROM child_sessions').all() as { session_id: string }[]
    return new Set(rows.map((r) => r.session_id))
  }

  /** A chat's children by the tool call that started each one. */
  children(parentId: string): Record<string, string> {
    const rows = this.db.prepare('SELECT session_id, tool_use_id FROM child_sessions WHERE parent_session = ?').all(parentId) as {
      session_id: string
      tool_use_id: string
    }[]
    return Object.fromEntries(rows.map((r) => [r.tool_use_id, r.session_id]))
  }

  addFork(fork: { sessionId: string; sourceId: string; cwd: string; worktree?: string; note?: string }): void {
    this.db
      .prepare('INSERT INTO forks (session_id, source_id, cwd, worktree, note, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(fork.sessionId, fork.sourceId, fork.cwd, fork.worktree ?? null, fork.note ?? null, Date.now())
  }

  /** A fork's folder, and the new worktree it starts in, while it hasn't. */
  forkStart(sessionId: string): { cwd: string; worktree: string } | undefined {
    const row = this.db.prepare('SELECT cwd, worktree FROM forks WHERE session_id = ? AND worktree IS NOT NULL').get(sessionId) as
      | { cwd: string; worktree: string }
      | undefined
    return row
  }

  /** The fork has started in its worktree, so later starts resume wherever it is. */
  forkStarted(sessionId: string): void {
    this.db.prepare('UPDATE forks SET worktree = NULL WHERE session_id = ?').run(sessionId)
  }

  /** What a fork that moved is told about it, until Claude has been. */
  forkNote(sessionId: string): string | undefined {
    const row = this.db.prepare('SELECT note FROM forks WHERE session_id = ?').get(sessionId) as { note: string | null } | undefined
    return row?.note ?? undefined
  }

  forkNoteSeen(sessionId: string): void {
    this.db.prepare('UPDATE forks SET note = NULL WHERE session_id = ?').run(sessionId)
  }

  removeFork(sessionId: string): void {
    this.db.prepare('DELETE FROM forks WHERE session_id = ?').run(sessionId)
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

  /** A machine's folders added by hand and folders taken off the list, by path. */
  folders(machine: string): { added: Map<string, number>; hidden: Set<string> } {
    const rows = this.db.prepare('SELECT path, added_at, hidden_at FROM machine_folders WHERE machine = ?').all(machine) as {
      path: string
      added_at: number
      hidden_at: number | null
    }[]
    return {
      added: new Map(rows.filter((r) => r.hidden_at === null).map((r) => [r.path, r.added_at])),
      hidden: new Set(rows.filter((r) => r.hidden_at !== null).map((r) => r.path)),
    }
  }

  addFolder(machine: string, path: string): void {
    this.db
      .prepare(
        'INSERT INTO machine_folders (machine, path, added_at) VALUES (?, ?, ?) ON CONFLICT(machine, path) DO UPDATE SET added_at = excluded.added_at, hidden_at = NULL',
      )
      .run(machine, path, Date.now())
  }

  hideFolder(machine: string, path: string): void {
    const now = Date.now()
    this.db
      .prepare(
        'INSERT INTO machine_folders (machine, path, added_at, hidden_at) VALUES (?, ?, ?, ?) ON CONFLICT(machine, path) DO UPDATE SET hidden_at = excluded.hidden_at',
      )
      .run(machine, path, now, now)
  }

  /** A card to put cards on, checked to exist and, when moving `cardId`, not to be it or below it. */
  private requireParent(parentId: unknown, cardId?: number): number | null {
    if (parentId === null) return null
    const id = Number(parentId)
    if (!Number.isInteger(id) || !this.card(id)) throw new BadRequest(`No card #${parentId}`)
    if (cardId !== undefined && (id === cardId || descendants(this.cards(), cardId).some((c) => c.id === id)))
      throw new BadRequest(`Card #${cardId} can't go inside itself`)
    return id
  }

  private endOf(status: CardStatus): number {
    const { max } = this.db.prepare('SELECT MAX(position) AS max FROM cards WHERE status = ?').get(status) as { max: number | null }
    return (max ?? 0) + 1
  }
}

function editable(c: Card): CardPatch {
  return { title: c.title, description: c.description, status: c.status, position: c.position, parentId: c.parentId }
}

function toCard(r: CardRow, sessionIds: string[], statusChangedAt?: number): Card {
  return {
    id: r.id,
    parentId: r.parent_id,
    title: r.title,
    description: r.description,
    status: r.status,
    position: r.position,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    // Cards older than the audit log have no record of it.
    statusChangedAt: statusChangedAt ?? r.created_at,
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
