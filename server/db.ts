import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

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
  // Side chats (/btw): forks of a chat in its own folder, kept under it and shown in a panel beside it rather than in the sidebar.
  `CREATE TABLE side_chats (
     session_id TEXT PRIMARY KEY,
     parent_session TEXT NOT NULL,
     created_at INTEGER NOT NULL
   );
   CREATE INDEX side_chats_parent ON side_chats(parent_session);`,
  // Analytics (see Analytics): what happened that transcripts and the audit log don't keep, for statistics later.
  // events: one row per thing that happened. card_id and project_id are where its chat was filed at the time.
  // client and tab are the browser and tab it came from; data is JSON, by kind.
  `CREATE TABLE events (
     id INTEGER PRIMARY KEY,
     at INTEGER NOT NULL,
     kind TEXT NOT NULL,
     actor TEXT,
     actor_session TEXT,
     client TEXT,
     tab TEXT,
     session_id TEXT,
     machine TEXT,
     card_id INTEGER,
     project_id INTEGER,
     duration_ms INTEGER,
     data TEXT
   );
   CREATE INDEX events_kind_at ON events (kind, at);
   CREATE INDEX events_session_at ON events (session_id, at) WHERE session_id IS NOT NULL;
   -- Browser tabs' heartbeats: sent when what's on screen or whether it's in use changes, and every few seconds while visible.
   -- Whether time counts as working is decided when reading them, not here. input_at is the last keypress, click, scroll or
   -- pointer move, on the hub's clock; inputs and keys count those since the tab's last beat, so in that beat's pane. Each
   -- row's state holds until the tab's next row; 'closed' ends it when the tab goes. views is the panels showing
   -- beside the chat (JSON view keys) and pane where the last input or focus was. busy: Claude was working in the chat shown.
   CREATE TABLE activity (
     id INTEGER PRIMARY KEY,
     at INTEGER NOT NULL,
     client TEXT NOT NULL,
     tab TEXT NOT NULL,
     reason TEXT NOT NULL,
     visible INTEGER NOT NULL,
     focused INTEGER NOT NULL,
     input_at INTEGER,
     inputs INTEGER NOT NULL,
     keys INTEGER NOT NULL,
     route TEXT NOT NULL,
     session_id TEXT,
     card_id INTEGER,
     project_id INTEGER,
     views TEXT,
     pane TEXT,
     busy INTEGER
   );
   CREATE INDEX activity_at ON activity (at);
   CREATE INDEX activity_tab_at ON activity (tab, at);
   -- Each browser, by an id it keeps in localStorage, and what it last said about itself (JSON: screen, touch, installed...).
   CREATE TABLE clients (
     id TEXT PRIMARY KEY,
     first_seen INTEGER NOT NULL,
     last_seen INTEGER NOT NULL,
     user_agent TEXT,
     info TEXT
   );
   -- Plan limits each time they're read, one row per limit; a plan without limits gets one row with an empty label.
   CREATE TABLE usage_samples (
     at INTEGER NOT NULL,
     machine TEXT,
     plan TEXT,
     label TEXT NOT NULL,
     percent REAL,
     severity TEXT,
     resets_at TEXT
   );
   CREATE INDEX usage_samples_at ON usage_samples (at);
   -- Transcript lines a rewritten (shrunk) transcript replaced, kept rather than lost with the old file.
   CREATE TABLE transcript_lines_replaced (
     session_id TEXT NOT NULL,
     subpath TEXT NOT NULL,
     n INTEGER NOT NULL,
     entry TEXT NOT NULL,
     replaced_at INTEGER NOT NULL
   );
   CREATE INDEX transcript_lines_replaced_session ON transcript_lines_replaced (session_id, subpath, replaced_at);`,
  // Review chats, and the chat whose changes each was started from.
  `CREATE TABLE review_sessions (
     session_id TEXT PRIMARY KEY,
     source_id TEXT NOT NULL,
     created_at INTEGER NOT NULL
   );`,
]

/** Who made a change. There are no users yet, so for now it's where the change came from. */
export type Actor = { source: 'ui' } | { source: 'claude'; sessionId: string }

type AuditEntity = 'card' | 'card_session' | 'archived_session'
type AuditAction = 'create' | 'update' | 'delete' | 'link' | 'unlink' | 'archive' | 'unarchive'

/**
 * Badger's SQLite database, migrated to the latest schema. Each table has one
 * owner, which alone runs SQL on it: the board's are Board's, a chat's
 * draft, archive and the like ChatMeta's, machines' Machines', which machine
 * each chat is on ChatPlacement's, transcripts Transcripts', and analytics
 * (events, activity, clients, usage_samples) Analytics'.
 */
export class Database {
  readonly sql: DatabaseSync
  private inTransaction = false

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true })
    this.sql = new DatabaseSync(join(dir, 'badger.db'))
    this.sql.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON')
    this.migrate()
  }

  private migrate(): void {
    const { user_version } = this.sql.prepare('PRAGMA user_version').get() as { user_version: number }
    for (let v = user_version; v < MIGRATIONS.length; v++) {
      this.transaction(() => {
        this.sql.exec(MIGRATIONS[v])
        this.sql.exec(`PRAGMA user_version = ${v + 1}`)
      })
    }
  }

  /** Joins the enclosing transaction if there is one, so writes that call each other stay atomic. */
  transaction<T>(fn: () => T): T {
    if (this.inTransaction) return fn()
    this.sql.exec('BEGIN')
    this.inTransaction = true
    try {
      const result = fn()
      this.sql.exec('COMMIT')
      return result
    } catch (err) {
      this.sql.exec('ROLLBACK')
      throw err
    } finally {
      this.inTransaction = false
    }
  }

  /** Records a change to board data, append-only. Call inside the same transaction as the change it records. */
  audit(actor: Actor, entity: AuditEntity, entityId: string | number, action: AuditAction, before: object | null, after: object | null): void {
    this.sql
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
}
