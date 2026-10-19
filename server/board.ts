import { descendants } from '../shared/cardTree.ts'
import { CARD_STATUSES, type Card, type CardStatus } from '../shared/protocol.ts'
import type { ChatMeta } from './chatMeta.ts'
import type { Actor, Database } from './db.ts'
import { BadRequest } from './errors.ts'

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

/** Project data that spans repos and users: cards and which chats belong to them. Every change is in the audit log. */
export class Board {
  constructor(
    private db: Database,
    /** Finishing a card archives its chats. */
    private chats: ChatMeta,
  ) {}

  /** Every card that isn't deleted. */
  cards(): Card[] {
    const rows = this.db.sql.prepare(`${VISIBLE} ORDER BY position`).all() as unknown as CardRow[]
    const links = this.db.sql.prepare('SELECT card_id, session_id FROM card_sessions ORDER BY created_at').all() as {
      card_id: number
      session_id: string
    }[]
    const sessions = new Map<number, string[]>()
    for (const l of links) sessions.set(l.card_id, [...(sessions.get(l.card_id) ?? []), l.session_id])
    const moved = this.statusChanges()
    return rows.map((r) => toCard(r, sessions.get(r.id) ?? [], moved.get(r.id)))
  }

  card(id: number): Card | undefined {
    const row = this.db.sql.prepare(`${VISIBLE} AND id = ?`).get(id) as CardRow | undefined
    if (!row) return undefined
    const links = this.db.sql.prepare('SELECT session_id FROM card_sessions WHERE card_id = ? ORDER BY created_at').all(id) as {
      session_id: string
    }[]
    return toCard(
      row,
      links.map((l) => l.session_id),
      this.statusChanges(id).get(id),
    )
  }

  /** The card a chat is on, if it's on one that isn't deleted. */
  cardOf(sessionId: string): Card | undefined {
    const row = this.db.sql.prepare('SELECT card_id FROM card_sessions WHERE session_id = ?').get(sessionId) as { card_id: number } | undefined
    return row ? this.card(row.card_id) : undefined
  }

  /** When each card (or just `id`) last changed status, by the audit log. Creating one counts. */
  private statusChanges(id?: number): Map<number, number> {
    const rows = this.db.sql
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
    return this.db.transaction(() => {
      const { lastInsertRowid } = this.db.sql
        .prepare('INSERT INTO cards (title, description, status, position, parent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(title, input.description ?? '', status, this.endOf(status), parentId, now, now)
      const card = this.card(Number(lastInsertRowid))!
      this.db.audit(actor, 'card', card.id, 'create', null, editable(card))
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
    this.db.transaction(() => {
      this.db.sql
        .prepare('UPDATE cards SET title = ?, description = ?, status = ?, position = ?, parent_id = ?, updated_at = ? WHERE id = ?')
        .run(next.title, next.description, next.status, next.position, next.parentId, Date.now(), id)
      this.db.audit(actor, 'card', id, 'update', before, after)
      // Finishing a card puts its chats away. Reopening it leaves them archived; messaging one brings it back.
      if (next.status === 'done' && current.status !== 'done') for (const s of current.sessionIds) this.chats.setArchived(s, true, actor)
    })
    return this.card(id)
  }

  /** Marks just this card deleted; the cards inside it are hidden with it. Chats stay linked but are no longer on a card. */
  deleteCard(id: number, actor: Actor): boolean {
    if (!this.card(id)) return false
    this.db.transaction(() => {
      this.db.sql.prepare('UPDATE cards SET deleted_at = ? WHERE id = ?').run(Date.now(), id)
      this.db.audit(actor, 'card', id, 'delete', null, null)
    })
    return true
  }

  /** Attaches a chat to a card, moving it off any card it was on. */
  linkSession(cardId: number, sessionId: string, actor: Actor): void {
    this.db.transaction(() => {
      const current = this.db.sql.prepare('SELECT card_id FROM card_sessions WHERE session_id = ?').get(sessionId) as { card_id: number } | undefined
      if (current?.card_id === cardId) return
      this.db.sql
        .prepare(
          'INSERT INTO card_sessions (session_id, card_id, created_at) VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET card_id = excluded.card_id',
        )
        .run(sessionId, cardId, Date.now())
      this.db.audit(actor, 'card_session', sessionId, 'link', current ? { cardId: current.card_id } : null, { cardId })
    })
  }

  unlinkSession(cardId: number, sessionId: string, actor: Actor): boolean {
    return this.db.transaction(() => {
      const removed = this.db.sql.prepare('DELETE FROM card_sessions WHERE card_id = ? AND session_id = ?').run(cardId, sessionId).changes > 0
      if (removed) this.db.audit(actor, 'card_session', sessionId, 'unlink', { cardId }, null)
      return removed
    })
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
    const { max } = this.db.sql.prepare('SELECT MAX(position) AS max FROM cards WHERE status = ?').get(status) as { max: number | null }
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
