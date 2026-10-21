import { execFileSync } from 'node:child_process'
import type { StatementSync } from 'node:sqlite'
import type { AccountUsage, ActivityBeat, ClientHello } from '../shared/protocol.ts'
import type { Board } from './board.ts'
import type { Actor, Database } from './db.ts'
import type { ChatPlacement } from './placement.ts'

/** What an event is about, besides its kind. Card and project are looked up from the chat when not given. */
export interface EventFields {
  actor?: Actor | 'system'
  /** The browser it came from. */
  client?: string
  tab?: string
  sessionId?: string
  machine?: string
  cardId?: number
  /** How long what it records took, for events that are the end of something. */
  durationMs?: number
  data?: Record<string, unknown>
}

/** A browser tab's identity, from its hello. */
export interface TabIdentity {
  client: string
  tab: string
}

/**
 * Activity and analytics, recorded as it happens for statistics later: there's
 * no UI on it yet, so it keeps what can't be worked out afterwards. Chats'
 * transcripts and the board's audit log already hold their own histories; this
 * holds what neither does: what the user was doing and looking at, what went
 * on in live processes and browsers, and plan usage over time.
 *
 * Every event is stamped with where it happened as it was then (the chat's
 * card, project and machine), since cards move and chats get filed later.
 * Owns the events, activity, clients and usage_samples tables.
 */
export class Analytics {
  readonly version = badgerVersion()
  private insertEvent?: StatementSync
  private insertBeat?: StatementSync
  /** Characters into and out of each terminal since the last flush. */
  private io = new Map<string, { in: number; out: number }>()

  constructor(
    private db: Database,
    private board: Board,
    private placement: ChatPlacement,
  ) {}

  /** Records one event. Never throws: analytics mustn't break what it watches. */
  event(kind: string, f: EventFields = {}): void {
    try {
      const where = this.where(f.sessionId, f.cardId)
      const actor = f.actor === 'system' ? 'system' : f.actor?.source
      const actorSession = f.actor && f.actor !== 'system' && f.actor.source === 'claude' ? f.actor.sessionId : null
      this.insertEvent ??= this.db.sql.prepare(
        `INSERT INTO events (at, kind, actor, actor_session, client, tab, session_id, machine, card_id, project_id, duration_ms, data)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      this.insertEvent.run(
        Date.now(),
        kind,
        actor ?? null,
        actorSession,
        f.client ?? null,
        f.tab ?? null,
        f.sessionId ?? null,
        f.machine ?? (f.sessionId ? (this.placement.machineOf(f.sessionId) ?? null) : null),
        where.cardId,
        where.projectId,
        f.durationMs ?? null,
        f.data ? JSON.stringify(f.data) : null,
      )
    } catch (err) {
      console.error(`Recording ${kind} failed:`, err)
    }
  }

  /** A browser tab said who it is: its browser is remembered, with what it said about itself. */
  hello(h: ClientHello): void {
    try {
      const now = Date.now()
      this.db.sql
        .prepare(
          `INSERT INTO clients (id, first_seen, last_seen, user_agent, info) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET last_seen = excluded.last_seen, user_agent = excluded.user_agent, info = excluded.info`,
        )
        .run(h.client, now, now, h.info.userAgent ?? null, JSON.stringify(h.info))
    } catch (err) {
      console.error('Recording a browser failed:', err)
    }
  }

  /** A tab's heartbeat: whether it's on screen and in use, and what's in it. `busy` is whether Claude is working in the chat it shows. */
  activity(tab: TabIdentity, beat: ActivityBeat, busy: boolean | undefined): void {
    try {
      const now = Date.now()
      const where = this.where(beat.sessionId, beat.cardId)
      this.insertBeat ??= this.db.sql.prepare(
        `INSERT INTO activity (at, client, tab, reason, visible, focused, input_at, inputs, keys, route, session_id, card_id, project_id, views, pane, busy)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      this.insertBeat.run(
        now,
        tab.client,
        tab.tab,
        beat.reason,
        beat.visible ? 1 : 0,
        beat.focused ? 1 : 0,
        // The browser's clock may be off; how long ago is measured on its own clock, so it isn't.
        beat.idleMs === undefined ? null : now - beat.idleMs,
        beat.inputs,
        beat.keys,
        beat.route,
        beat.sessionId ?? null,
        where.cardId,
        where.projectId,
        beat.views.length ? JSON.stringify(beat.views) : null,
        beat.pane ?? null,
        busy === undefined ? null : busy ? 1 : 0,
      )
    } catch (err) {
      console.error('Recording activity failed:', err)
    }
  }

  /** The tab went: one last beat saying it isn't on screen any more, so its time ends here and not at its last beat. */
  tabClosed(tab: TabIdentity): void {
    this.activity(tab, { reason: 'closed', visible: false, focused: false, inputs: 0, keys: 0, route: '', views: [] }, undefined)
  }

  /** Counts a terminal's input or output, by its `<machine>.<id>`. Written out now and then, not per keystroke; see flush. */
  terminalIo(id: string, dir: 'in' | 'out', chars: number): void {
    let io = this.io.get(id)
    if (!io) this.io.set(id, (io = { in: 0, out: 0 }))
    io[dir] += chars
  }

  /** Writes out what's been counted since last time. */
  flush(): void {
    if (!this.io.size) return
    const io = [...this.io]
    this.io.clear()
    try {
      this.db.transaction(() => {
        for (const [id, { in: input, out }] of io) this.event('terminal.io', { machine: id.split('.')[0], data: { id, in: input, out } })
      })
    } catch (err) {
      console.error('Recording terminal use failed:', err)
    }
  }

  /** Plan usage as read from a machine, one row per limit, for usage over time. */
  usage(machine: string | undefined, u: AccountUsage): void {
    try {
      const insert = this.db.sql.prepare('INSERT INTO usage_samples (at, machine, plan, label, percent, severity, resets_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      this.db.transaction(() => {
        if (!u.limits.length) insert.run(u.at, machine ?? null, u.plan, '', null, null, null)
        for (const l of u.limits) insert.run(u.at, machine ?? null, u.plan, l.label, l.percent, l.severity, l.resetsAt)
      })
    } catch (err) {
      console.error('Recording plan usage failed:', err)
    }
  }

  /** The card and its project (the top-level card it's in), given or from the chat's card. */
  private where(sessionId: string | undefined, cardId: number | undefined): { cardId: number | null; projectId: number | null } {
    const card = cardId !== undefined ? this.board.card(cardId) : sessionId ? this.board.cardOf(sessionId) : undefined
    if (!card) return { cardId: cardId ?? null, projectId: null }
    let project = card
    for (let i = 0; i < 50 && project.parentId !== null; i++) {
      const parent = this.board.card(project.parentId)
      if (!parent) break
      project = parent
    }
    return { cardId: card.id, projectId: project.id }
  }
}

/** Which Badger this is: the image's commit when built by CI, otherwise the checkout's. */
function badgerVersion(): string | undefined {
  if (process.env.BADGER_VERSION) return process.env.BADGER_VERSION
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 }).trim() || undefined
  } catch {
    return undefined
  }
}
