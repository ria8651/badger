import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync, StatementSync } from 'node:sqlite'
import { LOCAL_MACHINE } from '../shared/protocol.ts'
import { isUuid } from './runnerProtocol.ts'

/**
 * Which machine each chat is on. It's decided here and nowhere else: a chat
 * goes where the browser started it, a child where its parent is, and stays
 * there. Runners only ever act for chats already on their own machine.
 */
export class ChatPlacement {
  private machineOfQuery?: StatementSync

  constructor(
    private db: DatabaseSync,
    /** The store's, so a write here can join a transaction around it. */
    private transaction: <T>(fn: () => T) => T,
  ) {}

  machineOf(sessionId: string): string | undefined {
    // Asked on every event a runner sends, so prepared once.
    this.machineOfQuery ??= this.db.prepare('SELECT machine FROM chat_machines WHERE session_id = ?')
    const row = this.machineOfQuery.get(sessionId) as { machine: string } | undefined
    return row?.machine
  }

  /** Whether a runner may act for this chat: it's a chat id, and the chat is on that runner's machine. */
  owns(machine: string, sessionId: unknown): sessionId is string {
    return isUuid(sessionId) && this.machineOf(sessionId) === machine
  }

  /**
   * Puts a chat on a machine, unless it's already somewhere: chats stay on the
   * machine they started on. Returns where it is. Only for chats the hub
   * starts; a runner can't put chats anywhere.
   */
  assign(sessionId: string, machine: string): string {
    this.db.prepare('INSERT INTO chat_machines (session_id, machine, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING').run(sessionId, machine, Date.now())
    return this.machineOf(sessionId)!
  }

  /** Takes back a chat that never started where it was put, e.g. its folder wasn't there, so it can start somewhere else. */
  unassign(sessionId: string, machine: string): void {
    this.db.prepare('DELETE FROM chat_machines WHERE session_id = ? AND machine = ?').run(sessionId, machine)
  }

  /** Every chat on a machine. */
  chatsOn(machine: string): string[] {
    const rows = this.db.prepare('SELECT session_id FROM chat_machines WHERE machine = ?').all(machine) as { session_id: string }[]
    return rows.map((r) => r.session_id)
  }

  machinesOf(sessionIds: string[]): Map<string, string> {
    const rows = this.db
      .prepare('SELECT session_id, machine FROM chat_machines WHERE session_id IN (SELECT value FROM json_each(?))')
      .all(JSON.stringify(sessionIds)) as { session_id: string; machine: string }[]
    return new Map(rows.map((r) => [r.session_id, r.machine]))
  }

  /** Whether any chat was ever put on this id, so a new machine mustn't take it. */
  used(machine: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM chat_machines WHERE machine = ?').get(machine)
  }

  /**
   * Once, on the first start with machines: puts every chat Claude Code has
   * on this machine (in `projects`, its transcripts' folder) on the hub's
   * machine, since Badger didn't use to record which were its. Done before the
   * hub's runner connects, so its first chat list has them. After this, only
   * chats started in Badger are added.
   */
  importOlderChats(projects: string): void {
    if (!this.db.prepare('SELECT 1 FROM pending_import').get()) return
    const insert = this.db.prepare('INSERT OR IGNORE INTO chat_machines (session_id, machine, created_at) VALUES (?, ?, ?)')
    this.transaction(() => {
      for (const project of readdirSafe(projects)) {
        for (const name of readdirSafe(join(projects, project))) {
          const sessionId = name.slice(0, -'.jsonl'.length)
          if (!name.endsWith('.jsonl') || !isUuid(sessionId)) continue
          const info = statSync(join(projects, project, name), { throwIfNoEntry: false })
          if (info?.isFile()) insert.run(sessionId, LOCAL_MACHINE, Math.floor(info.mtimeMs))
        }
      }
      this.db.exec('DELETE FROM pending_import')
    })
  }
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}
